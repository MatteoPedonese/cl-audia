import { useEffect, useMemo, useRef, useState } from 'react'
import { TWord, Track, Word, fmtTime, trackWords, wordCuts } from './engine'

export interface AsrState {
  phase: 'download' | 'load' | 'transcribe'
  pct: number
}

interface Props {
  tracks: Track[]
  tx: Map<string, Word[]>
  trackId: string | null
  onTrackId: (id: string) => void
  asr: AsrState | null
  installed: boolean | null
  sizeMB: number
  /** il testo di questa traccia non è ancora stato ricavato */
  missing: boolean
  onTranscribe: () => void
  onCut: (trackId: string, cuts: [number, number][], count: number) => void
  onSeek: (t: number) => void
  getPos: () => number
  onClose: () => void
}

const PHASE: Record<AsrState['phase'], string> = {
  download: 'Scarico il modello di riconoscimento vocale…',
  load: 'Preparo il riconoscimento vocale…',
  transcribe: 'Ascolto e scrivo il testo…',
}

export default function Transcript(p: Props) {
  const voice = p.tracks.filter((t) => !t.duck && t.clips.length)
  const track = voice.find((t) => t.id === p.trackId) ?? voice[0] ?? null
  const words: TWord[] = useMemo(() => (track ? trackWords(track, p.tx) : []), [track, p.tx])
  const [sel, setSel] = useState<Set<number>>(new Set())
  const [cur, setCur] = useState(-1)
  const anchor = useRef(-1)
  const selRef = useRef(sel)
  selRef.current = sel
  const wordsRef = useRef(words)
  wordsRef.current = words

  // le parole cambiano dopo ogni taglio: la selezione non vale più
  useEffect(() => {
    setSel(new Set())
    anchor.current = -1
  }, [words.length, track?.id])

  // parola che si sta ascoltando
  useEffect(() => {
    const t = setInterval(() => {
      const pos = p.getPos()
      const ws = wordsRef.current
      let k = -1
      for (let i = 0; i < ws.length; i++) {
        if (ws[i].s <= pos + 0.01) k = i
        else break
      }
      if (k >= 0 && pos > ws[k].e + 0.6) k = -1
      setCur((c) => (c === k ? c : k))
    }, 120)
    return () => clearInterval(t)
  }, [])

  const doCut = (picked: Set<number>) => {
    if (!track || !picked.size) return
    const cuts = wordCuts(words, picked)
    if (cuts.length) p.onCut(track.id, cuts, picked.size)
  }

  useEffect(() => {
    const f = (e: KeyboardEvent) => {
      const tg = e.target as HTMLElement
      if (tg.tagName === 'INPUT' || tg.tagName === 'SELECT') return
      if ((e.key === 'Delete' || e.key === 'Backspace') && selRef.current.size) {
        e.preventDefault()
        doCut(selRef.current)
      }
    }
    window.addEventListener('keydown', f)
    return () => window.removeEventListener('keydown', f)
  })

  const click = (i: number, e: React.MouseEvent) => {
    p.onSeek(words[i].s)
    setSel((old) => {
      if (e.shiftKey && anchor.current >= 0) {
        const a = Math.min(anchor.current, i)
        const b = Math.max(anchor.current, i)
        const n = new Set(e.ctrlKey || e.metaKey ? old : [])
        for (let k = a; k <= b; k++) n.add(k)
        return n
      }
      anchor.current = i
      if (e.ctrlKey || e.metaKey) {
        const n = new Set(old)
        n.has(i) ? n.delete(i) : n.add(i)
        return n
      }
      return old.size === 1 && old.has(i) ? new Set() : new Set([i])
    })
  }

  const fillers = words.filter((w) => w.filler)
  const selSec = wordCuts(words, sel).reduce((a, [x, y]) => a + (y - x), 0)

  return (
    <aside className="drawer" aria-label="Montaggio dal testo">
      <div className="drawer-head">
        <h2>Montaggio dal testo</h2>
        <button className="icon" title="Chiudi" onClick={p.onClose}>
          ×
        </button>
      </div>

      {voice.length > 1 && (
        <div className="fmts" style={{ marginBottom: 10 }}>
          {voice.map((t) => (
            <button key={t.id} className={'chip' + (t.id === track?.id ? ' on' : '')} onClick={() => p.onTrackId(t.id)}>
              {t.name}
            </button>
          ))}
        </div>
      )}

      {!track && <p className="hint">Importa o registra un audio con la voce: poi potrai tagliarlo cancellando le parole.</p>}

      {track && p.asr && (
        <div className="asr-busy">
          <p>
            <b>{PHASE[p.asr.phase]}</b>
          </p>
          <div className="bar">
            <div style={{ width: `${Math.max(3, Math.round(p.asr.pct * 100))}%` }} />
          </div>
          <small>{Math.round(p.asr.pct * 100)}% — può volerci qualche minuto per audio lunghi. Puoi continuare a guardare il progetto.</small>
        </div>
      )}

      {track && !p.asr && p.missing && (
        <div className="asr-start">
          <p>
            L’app ascolta la voce e la trascrive in testo. Poi per tagliare basta <b>selezionare le parole e cancellarle</b>: l’audio si accorcia da solo.
          </p>
          {p.installed === false ? (
            <p className="asr-note">
              La prima volta va scaricato il riconoscimento vocale (circa <b>{p.sizeMB} MB</b>, serve internet, una volta sola). Poi funziona anche senza internet e
              l’audio non lascia mai il tuo computer.
            </p>
          ) : (
            <p className="asr-note">Tutto avviene sul tuo computer: l’audio non viene inviato a nessuno.</p>
          )}
          <button className="btn primary" onClick={p.onTranscribe}>
            {p.installed === false ? `Scarica e trascrivi “${track.name}”` : `Trascrivi “${track.name}”`}
          </button>
        </div>
      )}

      {track && !p.asr && !p.missing && words.length === 0 && <p className="hint">Non ho riconosciuto parole in questa traccia.</p>}

      {track && words.length > 0 && (
        <>
          <div className="tx-tools">
            <button className="btn sm" disabled={!fillers.length} onClick={() => setSel(new Set(fillers.map((w) => w.i)))} title="Seleziona tutti gli “ehm”, “uhm”…">
              Evidenzia gli “ehm” ({fillers.length})
            </button>
            <button className="btn sm danger" disabled={!sel.size} onClick={() => doCut(sel)}>
              Elimina {sel.size ? `(${sel.size})` : ''}
            </button>
            <button className="btn sm" disabled={!sel.size} onClick={() => setSel(new Set())}>
              Deseleziona
            </button>
          </div>
          <p className="tx-hint">
            {sel.size ? (
              <>
                {sel.size} {sel.size === 1 ? 'parola selezionata' : 'parole selezionate'} ({selSec.toFixed(1)} s) — premi <kbd>Canc</kbd> per toglierle.
              </>
            ) : (
              <>
                Clicca una parola per ascoltarla da lì e selezionarla · <kbd>Maiusc</kbd>+clic per un tratto · <kbd>Ctrl</kbd>+clic per aggiungerne.
              </>
            )}
          </p>
          <div className="tx-text">
            {words.map((w) => (
              <span
                key={w.i}
                className={'tw' + (w.filler ? ' filler' : '') + (sel.has(w.i) ? ' sel' : '') + (cur === w.i ? ' cur' : '')}
                title={fmtTime(w.s)}
                onClick={(e) => click(w.i, e)}
              >
                {w.w}{' '}
              </span>
            ))}
          </div>
          <small className="asr-note">
            Il riconoscimento non è perfetto: se una parola è sbagliata, il taglio resta comunque preciso sul suono. Puoi sempre annullare con Ctrl+Z.
          </small>
        </>
      )}
    </aside>
  )
}
