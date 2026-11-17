import { useEffect, useRef, useState } from 'react'
import { SR, fmtTime } from './engine'

interface Props {
  outId: string
  onOutChange: (id: string) => void
  onClose: () => void
  onDone: (path: string, inputLatency: number, listened: boolean) => void
  canListen: boolean // il progetto ha già dell'audio da ascoltare
  onStart: (listen: boolean) => void
  onStop: () => void
}

const WORKLET = `
class Rec extends AudioWorkletProcessor {
  constructor() {
    super()
    this.buf = new Float32Array(4096)
    this.n = 0
    this.port.onmessage = (e) => {
      if (e.data === 'flush') {
        if (this.n) this.port.postMessage(this.buf.slice(0, this.n))
        this.n = 0
        this.port.postMessage('done')
      }
    }
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0]
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        this.buf[this.n++] = ch[i]
        if (this.n === 4096) { this.port.postMessage(this.buf.slice(0)); this.n = 0 }
      }
    }
    return true
  }
}
registerProcessor('rec', Rec)
`

function describe(e: unknown): string {
  const n = (e as DOMException)?.name
  if (n === 'NotAllowedError' || n === 'SecurityError')
    return 'L’accesso al microfono è bloccato. Abilitalo nelle impostazioni di sistema (Privacy → Microfono) e riapri questa finestra.'
  if (n === 'NotFoundError') return 'Nessun microfono trovato. Collegane uno e riprova.'
  if (n === 'NotReadableError') return 'Il microfono è in uso da un’altra app. Chiudila e riprova.'
  return `Impossibile usare il microfono: ${(e as Error)?.message ?? e}`
}

export default function Recorder({ outId, onOutChange, onClose, onDone, canListen, onStart, onStop }: Props) {
  const [mics, setMics] = useState<MediaDeviceInfo[]>([])
  const [outs, setOuts] = useState<MediaDeviceInfo[]>([])
  const [micId, setMicId] = useState(() => localStorage.getItem('micId') ?? '')
  const [err, setErr] = useState<string | null>(null)
  const [ready, setReady] = useState(false)
  const [recording, setRecording] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [hot, setHot] = useState(false)
  const [listen, setListen] = useState(() => localStorage.getItem('recListen') === '1')

  const meterRef = useRef<HTMLDivElement>(null)
  const g = useRef<{
    stream?: MediaStream
    ctx?: AudioContext
    src?: MediaStreamAudioSourceNode
    silent?: GainNode
    node?: AudioWorkletNode
    raf?: number
    samples: number
    recording: boolean
    loaded?: boolean
  }>({ samples: 0, recording: false })

  const refreshDevices = async () => {
    const d = await navigator.mediaDevices.enumerateDevices()
    setMics(d.filter((x) => x.kind === 'audioinput' && x.deviceId !== 'communications'))
    setOuts(d.filter((x) => x.kind === 'audiooutput' && x.deviceId !== 'communications'))
  }

  function teardown() {
    const s = g.current
    if (s.raf) cancelAnimationFrame(s.raf)
    try { s.node?.disconnect() } catch {}
    s.stream?.getTracks().forEach((t) => t.stop())
    s.ctx?.close().catch(() => {})
    g.current = { samples: 0, recording: false }
  }

  // apre il microfono scelto e mostra il livello
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      teardown()
      setReady(false)
      try {
        await window.api.micAccess()
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            deviceId: micId ? { exact: micId } : undefined,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: false,
            channelCount: 1,
          },
        })
        if (cancelled) return stream.getTracks().forEach((t) => t.stop())
        const ctx = new AudioContext({ sampleRate: SR })
        const src = ctx.createMediaStreamSource(stream)
        const an = ctx.createAnalyser()
        an.fftSize = 1024
        const silent = ctx.createGain()
        silent.gain.value = 0 // il microfono non esce dagli altoparlanti (niente eco)
        src.connect(an)
        an.connect(silent)
        silent.connect(ctx.destination)
        await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' })))
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop())
          ctx.close()
          return
        }
        const data = new Float32Array(an.fftSize)
        const tick = () => {
          an.getFloatTimeDomainData(data)
          let pk = 0
          for (let i = 0; i < data.length; i++) pk = Math.max(pk, Math.abs(data[i]))
          const db = 20 * Math.log10(Math.max(pk, 1e-5))
          const lvl = Math.min(1, Math.max(0, (db + 60) / 60))
          if (meterRef.current) meterRef.current.style.width = `${lvl * 100}%`
          setHot((h) => (h !== pk > 0.97 ? pk > 0.97 : h))
          g.current.raf = requestAnimationFrame(tick)
        }
        g.current = { ...g.current, stream, ctx, src, silent, samples: 0, recording: false }
        tick()
        await refreshDevices()
        setErr(null)
        setReady(true)
      } catch (e) {
        if (cancelled) return
        if ((e as DOMException).name === 'OverconstrainedError' && micId) {
          localStorage.removeItem('micId')
          setMicId('')
          return
        }
        setErr(describe(e))
      }
    })()
    return () => {
      cancelled = true
      if (g.current.recording) window.api.recCancel()
      teardown()
    }
  }, [micId])

  useEffect(() => {
    const f = () => refreshDevices().catch(() => {})
    navigator.mediaDevices.addEventListener('devicechange', f)
    return () => navigator.mediaDevices.removeEventListener('devicechange', f)
  }, [])

  async function startRec() {
    const s = g.current
    if (!s.ctx || !s.src || !s.silent) return
    await window.api.recBegin()
    const node = new AudioWorkletNode(s.ctx, 'rec')
    s.samples = 0
    node.port.onmessage = (e) => {
      if (e.data === 'done') return
      const f = e.data as Float32Array
      const i16 = new Int16Array(f.length)
      for (let i = 0; i < f.length; i++) i16[i] = Math.max(-1, Math.min(1, f[i])) * 32767
      g.current.samples += f.length
      window.api.recChunk(i16.buffer)
    }
    s.src.connect(node)
    node.connect(s.silent)
    s.node = node
    s.recording = true
    setElapsed(0)
    setRecording(true)
    onStart(canListen && listen)
  }

  async function stopRec() {
    const s = g.current
    if (!s.node || !s.src) return
    onStop()
    const node = s.node
    await new Promise<void>((res) => {
      const prev = node.port.onmessage
      node.port.onmessage = (e) => {
        prev?.call(node.port, e)
        if (e.data === 'done') res()
      }
      node.port.postMessage('flush')
    })
    s.src.disconnect(node)
    node.disconnect()
    s.node = undefined
    s.recording = false
    setRecording(false)
    if (s.samples < SR * 0.3) {
      await window.api.recCancel()
      setErr('Registrazione troppo breve: riprova.')
      return
    }
    const r = await window.api.recEnd(SR)
    const trackLat = (s.stream?.getAudioTracks()[0]?.getSettings() as { latency?: number } | undefined)?.latency ?? 0
    if (r.path) onDone(r.path, trackLat + (s.ctx?.baseLatency ?? 0), canListen && listen)
    else setErr(r.error ?? 'Errore durante il salvataggio della registrazione.')
  }

  // cronometro
  useEffect(() => {
    if (!recording) return
    const t = setInterval(() => setElapsed(g.current.samples / SR), 100)
    return () => clearInterval(t)
  }, [recording])

  return (
    <div className="modal-bg" onClick={() => !recording && onClose()}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Registra la tua voce</h2>

        <div className="field">
          <span>Microfono</span>
          <select
            disabled={recording}
            value={micId}
            onChange={(e) => {
              localStorage.setItem('micId', e.target.value)
              setMicId(e.target.value)
            }}
          >
            <option value="">Predefinito del sistema</option>
            {mics
              .filter((m) => m.deviceId !== 'default')
              .map((m, i) => (
                <option key={m.deviceId} value={m.deviceId}>
                  {m.label || `Microfono ${i + 1}`}
                </option>
              ))}
          </select>
          <div className={'meter' + (hot ? ' hot' : '')}>
            <div ref={meterRef} />
          </div>
          <small>
            {hot ? 'Troppo forte! Allontanati dal microfono o abbassa il volume di ingresso.' : 'Prova a parlare: la barra deve muoversi senza arrivare al rosso.'}
          </small>
        </div>

        <div className="field">
          <span>Ascolto (cuffie / altoparlanti)</span>
          <select value={outId} onChange={(e) => onOutChange(e.target.value)}>
            <option value="">Predefinito del sistema</option>
            {outs
              .filter((o) => o.deviceId !== 'default')
              .map((o, i) => (
                <option key={o.deviceId} value={o.deviceId}>
                  {o.label || `Uscita ${i + 1}`}
                </option>
              ))}
          </select>
        </div>

        {canListen && (
          <label className="check big">
            <input
              type="checkbox"
              disabled={recording}
              checked={listen}
              onChange={(e) => {
                setListen(e.target.checked)
                localStorage.setItem('recListen', e.target.checked ? '1' : '0')
              }}
            />
            <div>
              <b>Ascolta il progetto mentre registri</b>
              <small>Per parlare sopra una base musicale o rispondere a un’intervista già registrata. Usa le cuffie, altrimenti l’audio del progetto finisce nel microfono.</small>
            </div>
          </label>
        )}

        {err && <p className="err">{err}</p>}

        <div className="rec-box">
          <button className={'rec-btn' + (recording ? ' on' : '')} disabled={!ready && !recording} onClick={recording ? stopRec : startRec} title={recording ? 'Ferma' : 'Registra'}>
            <span />
          </button>
          <div className="rec-time">{recording ? fmtTime(elapsed) : ready ? 'Pronto' : err ? '—' : 'Attendo il microfono…'}</div>
        </div>
        <small className="rec-note">
          La registrazione viene salvata in <b>Documenti › Podcast Editor › Registrazioni</b> e aggiunta alla timeline nel punto del cursore.
        </small>

        <div className="modal-actions">
          <button className="btn" disabled={recording} onClick={onClose}>
            Chiudi
          </button>
        </div>
      </div>
    </div>
  )
}
