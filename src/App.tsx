import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import Timeline, { Range } from './Timeline'
import Recorder from './Recorder'
import Logo, { LogoMark } from './Logo'
import Transcript, { AsrState } from './Transcript'
import {
  Chapter,
  Clip,
  SILENCE_LEVELS,
  SR,
  SilenceLevel,
  Track,
  Word,
  analyze,
  applyCuts,
  bufferFromS16,
  clamp,
  clampFades,
  computePeaks,
  crossfade,
  fmtTime,
  isContinuous,
  planSilenceCuts,
  prevAdjacent,
  projectEnd,
  removeClip,
  removeRange,
  renderChunk,
  schedule,
  shiftChapters,
  sources,
  splitAt,
  uid,
  updateClip,
} from './engine'

const COLORS = ['#5b9bff', '#fb7c5a', '#34d3b0', '#b28cff', '#ffc857', '#ff7aa8']
const newTrack = (i: number): Track => ({ id: uid(), name: `Traccia ${i + 1}`, color: COLORS[i % COLORS.length], muted: false, volume: 1, clips: [] })

interface Hist {
  p: Track[]
  past: Track[][]
  future: Track[][]
}

const FORMATS = [
  { id: 'mp3', label: 'MP3', hint: 'Il più compatibile: ideale per pubblicare il podcast', lossy: true },
  { id: 'm4a', label: 'M4A (AAC)', hint: 'Ottimo rapporto qualità/peso', lossy: true },
  { id: 'wav', label: 'WAV', hint: 'Qualità piena, file molto grande', lossy: false },
  { id: 'flac', label: 'FLAC', hint: 'Qualità piena, file più piccolo del WAV', lossy: false },
  { id: 'ogg', label: 'OGG', hint: 'Formato aperto, buona compressione', lossy: true },
]

const INITIAL: Track[] = [newTrack(0), newTrack(1)]
const NO_CH: Chapter[] = [] // stessa istanza: "modificato" si confronta per riferimento

interface Template {
  id: string
  icon: string
  name: string
  desc: string
  tracks: { name: string; duck?: boolean }[]
  hint: string
}
const TEMPLATES: Template[] = [
  { id: 'blank', icon: '＋', name: 'Progetto vuoto', desc: 'Due tracce vuote: parti da zero.', tracks: [{ name: 'Traccia 1' }, { name: 'Traccia 2' }], hint: '' },
  {
    id: 'solo',
    icon: '🎙',
    name: 'Solo voce con intro e outro',
    desc: 'Una traccia per la tua voce e una per la musica di apertura e di chiusura.',
    tracks: [{ name: 'Voce' }, { name: 'Intro e outro' }],
    hint: 'Importa o registra la voce sulla traccia “Voce”, poi trascina la musica di apertura e di chiusura sull’altra traccia.',
  },
  {
    id: 'intervista',
    icon: '👥',
    name: 'Intervista a due',
    desc: 'Una traccia per te, una per l’ospite e una per la musica, che si abbassa quando parlate.',
    tracks: [{ name: 'Conduttore' }, { name: 'Ospite' }, { name: 'Musica', duck: true }],
    hint: 'Importa la tua voce su “Conduttore” e quella dell’ospite su “Ospite”; la musica si abbassa da sola quando si parla.',
  },
  {
    id: 'musica',
    icon: '🎵',
    name: 'Voce con musica di sottofondo',
    desc: 'La tua voce e una base musicale che si abbassa da sola quando parli.',
    tracks: [{ name: 'Voce' }, { name: 'Musica', duck: true }],
    hint: 'Importa o registra la voce sulla traccia “Voce” e la musica su “Musica”: si abbasserà da sola quando parli.',
  },
]

type Preset = 'podcast' | 'max' | 'custom'
const PRESETS: { id: Preset; icon: string; label: string; desc: string }[] = [
  { id: 'podcast', icon: '🎙', label: 'Podcast', desc: 'MP3, qualità buona, volume uniforme: leggero e accettato da tutte le app di podcast.' },
  { id: 'max', icon: '💎', label: 'Qualità massima', desc: 'FLAC senza perdita di qualità, volume originale: ideale per archiviare o rielaborare.' },
  { id: 'custom', icon: '⚙', label: 'Personalizzato', desc: 'Scegli tu formato, qualità e volume.' },
]
/** Dimensione approssimativa del file esportato, in byte. */
function estimateBytes(fmt: string, quality: string, sec: number) {
  const hq = quality === 'high'
  if (fmt === 'mp3' || fmt === 'm4a') return (sec * (hq ? 256 : 160) * 1000) / 8
  if (fmt === 'ogg') return (sec * (hq ? 192 : 128) * 1000) / 8
  if (fmt === 'wav') return sec * SR * 4
  return sec * SR * 4 * 0.6 // flac
}
const fmtSize = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : `${(b / 1e6).toFixed(b < 1e7 ? 1 : 0)} MB`).replace('.', ',')
const fmtDur = (s: number) => {
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = Math.round(s % 60)
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`
}

type ExportMeta = NonNullable<Parameters<Window['api']['exportBegin']>[0]['meta']>
const defaultMeta = (): ExportMeta => ({
  title: '',
  artist: localStorage.getItem('metaArtist') ?? '',
  album: localStorage.getItem('metaAlbum') ?? '',
  track: '',
  year: String(new Date().getFullYear()),
  comment: '',
  cover: null,
})
const fmtSec = (n: number) => String(n).replace('.', ',')
const LEVEL_LABEL: Record<SilenceLevel, string> = { light: 'Leggera', medium: 'Normale', strong: 'Forte' }

export default function App() {
  const [h, setH] = useState<Hist>(() => ({ p: INITIAL, past: [], future: [] }))
  const [saved, setSaved] = useState<Track[] | null>(INITIAL) // stato dell'ultimo salvataggio (null = mai salvato con modifiche)
  const [projectPath, setProjectPath] = useState<string | null>(null)
  const [showRec, setShowRec] = useState(false)
  const [outId, setOutId] = useState(() => localStorage.getItem('outId') ?? '')
  const [meta, setMeta] = useState<ExportMeta>(defaultMeta)
  const [coverUrl, setCoverUrl] = useState<string | null>(null)
  const [silence, setSilence] = useState<{ level: SilenceLevel; scope: 'selected' | 'all' } | null>(null)
  const [recovery, setRecovery] = useState<{ text: string; mtime: number; path: string | null } | null>(null)
  const [chapters, setChapters] = useState<Chapter[]>(NO_CH)
  const [savedChapters, setSavedChapters] = useState<Chapter[]>(NO_CH)
  const [showChapters, setShowChapters] = useState(false)
  const [showTemplates, setShowTemplates] = useState(false)
  const [hint, setHint] = useState<string | null>(null)
  const [showText, setShowText] = useState(false)
  const [txTrack, setTxTrack] = useState<string | null>(null)
  const [tx, setTx] = useState<Map<string, Word[]>>(() => new Map())
  const [asr, setAsr] = useState<AsrState | null>(null)
  const [asrInfo, setAsrInfo] = useState<{ installed: boolean; sizeMB: number } | null>(null)
  const asrActive = useRef(false)
  const recAt = useRef(0)
  const tracks = h.p
  const tracksRef = useRef(tracks)
  tracksRef.current = tracks

  const commit = useCallback((fn: (t: Track[]) => Track[]) => setH((x) => ({ p: fn(x.p), past: [...x.past.slice(-99), x.p], future: [] })), [])
  const live = useCallback((fn: (t: Track[]) => Track[]) => setH((x) => ({ ...x, p: fn(x.p) })), [])
  const mark = useCallback(() => setH((x) => ({ ...x, past: [...x.past.slice(-99), x.p], future: [] })), [])
  const unmark = useCallback(() => setH((x) => ({ ...x, p: x.p, past: x.past.slice(0, -1) })), [])
  const undo = () => setH((x) => (x.past.length ? { p: x.past[x.past.length - 1], past: x.past.slice(0, -1), future: [x.p, ...x.future] } : x))
  const redo = () => setH((x) => (x.future.length ? { p: x.future[0], past: [...x.past, x.p], future: x.future.slice(1) } : x))

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [range, setRange] = useState<Range | null>(null)
  const [pps, setPps] = useState(40)
  const [ripple, setRipple] = useState(true)
  const [playing, setPlaying] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [srcVer, setSrcVer] = useState(0)
  const [showExport, setShowExport] = useState(false)
  const [exportState, setExportState] = useState<{ progress: number; done?: string; error?: string } | null>(null)
  const [dragOver, setDragOver] = useState(false)

  const scrollRef = useRef<HTMLDivElement>(null)
  const playheadRef = useRef<HTMLDivElement>(null)
  const timeRef = useRef<HTMLSpanElement>(null)
  const posRef = useRef(0)
  const ppsRef = useRef(pps)
  ppsRef.current = pps
  const pendingScroll = useRef<number | null>(null)

  const end = projectEnd(tracks)
  const selected: Clip | null = tracks.flatMap((t) => t.clips).find((c) => c.id === selectedId) ?? null
  const hasAudio = end > 0
  const dirty = tracks !== saved || chapters !== savedChapters
  const projectName = projectPath ? (projectPath.split(/[\\/]/).pop() ?? '').replace(/\.podcast$/i, '') : 'Senza titolo'

  useEffect(() => {
    document.title = `${dirty ? '• ' : ''}${projectName} — Tidycast`
    window.onbeforeunload = dirty ? () => false : null
  }, [dirty, projectName])

  const flash = (m: string) => {
    setToast(m)
    setTimeout(() => setToast((t) => (t === m ? null : t)), 4000)
  }

  // ---------- Posizione / playhead ----------
  const renderPos = useCallback(() => {
    const el = playheadRef.current
    if (el) el.style.transform = `translateX(${posRef.current * ppsRef.current}px)`
    if (timeRef.current) timeRef.current.textContent = fmtTime(posRef.current)
  }, [])
  useLayoutEffect(renderPos, [pps, renderPos, hasAudio])

  // ---------- Riproduzione ----------
  const ctxRef = useRef<AudioContext | null>(null)
  const play = useRef<{ nodes: AudioScheduledSourceNode[]; startCtx: number; from: number; raf: number } | null>(null)

  const stopNodes = () => {
    const pl = play.current
    if (!pl) return
    cancelAnimationFrame(pl.raf)
    for (const n of pl.nodes) {
      try {
        n.stop()
        n.disconnect()
      } catch {}
    }
    play.current = null
  }

  const pause = useCallback(() => {
    stopNodes()
    setPlaying(false)
    renderPos()
  }, [renderPos])

  const start = useCallback(
    (from: number) => {
      stopNodes()
      if (!ctxRef.current) {
        ctxRef.current = new AudioContext({ sampleRate: SR })
        applySink(ctxRef.current, localStorage.getItem('outId') ?? '')
      }
      const ctx = ctxRef.current
      ctx.resume()
      const startCtx = ctx.currentTime + 0.05
      const nodes = schedule(ctx, ctx.destination, tracksRef.current, from, Infinity, startCtx)
      const tick = () => {
        const pl = play.current
        if (!pl) return
        const pos = pl.from + Math.max(0, ctx.currentTime - pl.startCtx)
        const e = projectEnd(tracksRef.current)
        if (pos >= e) {
          posRef.current = e
          pause()
          return
        }
        posRef.current = pos
        renderPos()
        const sc = scrollRef.current
        if (sc) {
          const x = pos * ppsRef.current
          if (x > sc.scrollLeft + sc.clientWidth - 40 || x < sc.scrollLeft) sc.scrollLeft = Math.max(0, x - 80)
        }
        pl.raf = requestAnimationFrame(tick)
      }
      play.current = { nodes, startCtx, from, raf: requestAnimationFrame(tick) }
      setPlaying(true)
    },
    [pause, renderPos],
  )

  const togglePlay = useCallback(() => {
    if (play.current) pause()
    else if (projectEnd(tracksRef.current) > 0) {
      if (posRef.current >= projectEnd(tracksRef.current) - 0.01) posRef.current = 0
      start(posRef.current)
    }
  }, [pause, start])

  const seek = useCallback(
    (t: number) => {
      posRef.current = Math.max(0, t)
      renderPos()
      if (play.current) start(posRef.current)
    },
    [renderPos, start],
  )

  // se si modifica il progetto durante la riproduzione, riparti dalla posizione corrente
  useEffect(() => {
    if (play.current) start(posRef.current)
  }, [tracks])
  useEffect(() => () => stopNodes(), [])

  // ---------- Zoom ----------
  const zoomTo = useCallback((next: number, anchorPx?: number) => {
    const sc = scrollRef.current
    const old = ppsRef.current
    next = clamp(next, 2, 600)
    if (sc) {
      const ax = anchorPx ?? sc.clientWidth / 2
      pendingScroll.current = ((sc.scrollLeft + ax) / old) * next - ax
    }
    setPps(next)
  }, [])
  const onZoom = useCallback((f: number, ax: number) => zoomTo(ppsRef.current * f, ax), [zoomTo])
  useLayoutEffect(() => {
    if (pendingScroll.current != null && scrollRef.current) {
      scrollRef.current.scrollLeft = Math.max(0, pendingScroll.current)
      pendingScroll.current = null
    }
  }, [pps])
  const fit = useCallback(() => {
    const sc = scrollRef.current
    const e = projectEnd(tracksRef.current)
    if (!sc || e <= 0) return
    setPps(clamp((sc.clientWidth - 60) / e, 2, 600))
    pendingScroll.current = 0
  }, [])

  // ---------- Modifiche ----------
  const doSplit = () => {
    const t = posRef.current
    const r = splitAt(tracksRef.current, t, selectedId)
    if (r.rightId === null) return flash('Posiziona il cursore dentro un pezzo di audio (clicca sull’onda) per dividerlo.')
    commit(() => r.tracks)
    setSelectedId(selectedId ? r.rightId : null)
  }

  const doDelete = () => {
    if (range) {
      commit((ts) => removeRange(ts, range.a, range.b, ripple))
      if (ripple) setChapters((cs) => shiftChapters(cs, range.a, range.b))
      posRef.current = range.a
      setRange(null)
      renderPos()
    } else if (selectedId) {
      commit((ts) => removeClip(ts, selectedId, ripple))
      setSelectedId(null)
    } else flash('Seleziona un pezzo di audio, oppure trascina sul righello per scegliere la parte da eliminare.')
  }

  const setClip = (id: string, fn: (c: Clip) => Clip) => commit((ts) => updateClip(ts, id, fn))
  // l'abbassamento automatico della musica entra nella cronologia (annullabile); nome/volume/muto no
  const onTrack = useCallback(
    (id: string, patch: Partial<Track>) => ('duck' in patch ? commit : live)((ts) => ts.map((t) => (t.id === id ? { ...t, ...patch } : t))),
    [live, commit],
  )
  const onAddTrack = useCallback(() => commit((ts) => [...ts, newTrack(ts.length)]), [commit])
  const onRemoveTrack = useCallback(
    (id: string) => {
      const t = tracksRef.current.find((x) => x.id === id)
      if (t && t.clips.length && !confirm(`Eliminare "${t.name}" e tutto il suo audio?`)) return
      commit((ts) => ts.filter((x) => x.id !== id))
    },
    [commit],
  )

  // ---------- Import ----------
  async function loadSource(p: string, id = uid()): Promise<string> {
    const r = await window.api.decode(p)
    if (!r.ok) throw new Error(r.error)
    const buf = bufferFromS16(r.data)
    sources.set(id, { id, name: r.name, path: p, buffer: buf, peaks: computePeaks(buf), blk: 128 })
    setSrcVer((v) => v + 1)
    return id
  }

  /** `at`: usato per le registrazioni, mette il clip in quel punto (o al cursore, se `true`) sulla prima traccia libera. `srcOffset`: secondi da saltare all'inizio del file. */
  const importPaths = async (paths: string[], at?: number | boolean, srcOffset = 0) => {
    const atPlayhead = at !== undefined && at !== false
    const atPos = typeof at === 'number' ? at : posRef.current
    const wasEmpty = projectEnd(tracksRef.current) === 0
    for (const p of paths) {
      const name = p.split(/[\\/]/).pop() ?? p
      try {
        setBusy(atPlayhead ? 'Aggiungo la registrazione…' : `Importo “${name}”…`)
        const id = await loadSource(p)
        const off = Math.min(srcOffset, Math.max(0, sources.get(id)!.buffer.duration - 0.1))
        const dur = sources.get(id)!.buffer.duration - off
        const clip: Clip = { id: uid(), sourceId: id, srcStart: off, duration: dur, start: atPlayhead ? atPos : 0, fadeIn: 0, fadeOut: 0, gain: 1 }
        commit((ts) => {
          if (atPlayhead) {
            const s = clip.start
            const i = ts.findIndex((t) => t.clips.every((c) => c.start + c.duration <= s || c.start >= s + dur))
            return i < 0 ? [...ts, { ...newTrack(ts.length), clips: [clip] }] : ts.map((t, k) => (k === i ? { ...t, clips: [...t.clips, clip] } : t))
          }
          const i = ts.findIndex((t) => t.clips.length === 0)
          return i < 0 ? [...ts, { ...newTrack(ts.length), clips: [clip] }] : ts.map((t, k) => (k === i ? { ...t, clips: [clip] } : t))
        })
        setSelectedId(clip.id)
      } catch (e) {
        flash(`Impossibile importare “${name}”: ${(e as Error).message}`)
      }
    }
    setBusy(null)
    if (!atPlayhead || wasEmpty) setTimeout(fit, 60)
  }

  // ---------- Progetto: nuovo / apri / salva ----------
  const confirmDiscard = () => !dirty || confirm('Ci sono modifiche non salvate. Vuoi continuare senza salvarle?')

  const resetTo = (t: Track[], savedState: Track[] | null, path: string | null, ch: Chapter[] = NO_CH) => {
    pause()
    setChapters(ch)
    setSavedChapters(ch)
    posRef.current = 0
    renderPos()
    setH({ p: t, past: [], future: [] })
    setSaved(savedState)
    setProjectPath(path)
    setSelectedId(null)
    setRange(null)
  }

  const newProject = () => {
    if (!confirmDiscard()) return
    setShowTemplates(true)
  }

  const createProject = (tpl: Template) => {
    sources.clear()
    enhCache.current.clear()
    setTx(new Map())
    const t = tpl.tracks.map((x, i) => ({ ...newTrack(i), name: x.name, duck: x.duck }))
    resetTo(t, t, null)
    setMeta(defaultMeta())
    setCoverUrl(null)
    setSrcVer((v) => v + 1)
    setShowTemplates(false)
    setShowText(false)
    if (tpl.hint) {
      setHint(tpl.hint)
      setTimeout(() => setHint((h) => (h === tpl.hint ? null : h)), 12000)
    }
  }

  /** `withPath`: per il salvataggio automatico, ricorda a quale progetto appartiene. */
  const buildProjectText = (snapshot: Track[], withPath = false) => {
    const used = new Set<string>()
    for (const c of snapshot.flatMap((t) => t.clips)) {
      used.add(c.sourceId)
      if (c.origSourceId) used.add(c.origSourceId)
      if (c.enhSourceId) used.add(c.enhSourceId)
    }
    const srcs = [...used].flatMap((id) => {
      const s = sources.get(id)
      return s ? [{ id, name: s.name, path: s.path }] : []
    })
    const transcripts: Record<string, Word[]> = {}
    for (const id of used) if (tx.has(id)) transcripts[id] = tx.get(id)!
    const text = JSON.stringify(
      { app: 'tidycast', version: 3, projectPath: withPath ? projectPath : undefined, sources: srcs, tracks: snapshot, meta, chapters, transcripts },
      null,
      1,
    )
    return { text, first: srcs[0]?.name }
  }
  const buildRef = useRef(buildProjectText)
  buildRef.current = buildProjectText

  const loadProject = async (path: string | null, text: string, forceDirty = false) => {
    let proj: { app?: string; sources?: { id: string; name: string; path: string }[]; tracks?: Track[]; meta?: Partial<ExportMeta>; chapters?: Chapter[]; transcripts?: Record<string, Word[]> }
    try {
      proj = JSON.parse(text)
      // 'podcast-editor' è il vecchio nome dell'app: i progetti già salvati restano apribili
      if (!['tidycast', 'podcast-editor'].includes(proj.app ?? '') || !proj.tracks || !proj.sources) throw new Error()
    } catch {
      return flash('Questo file non è un progetto di Tidycast valido.')
    }
    pause()
    sources.clear()
    enhCache.current.clear()
    setShowText(false)
    const ok = new Set<string>()
    const missing: string[] = []
    for (const s of proj.sources!) {
      try {
        setBusy(`Carico “${s.name}”…`)
        await loadSource(s.path, s.id)
        sources.get(s.id)!.name = s.name // mantiene il nome mostrato (es. “… · voce migliorata”)
        ok.add(s.id)
      } catch {
        missing.push(s.name)
      }
    }
    setBusy(null)
    const t = proj.tracks!.map((tr) => ({
      ...tr,
      clips: tr.clips.flatMap((c) => {
        if (ok.has(c.sourceId)) return [c]
        // versione "voce migliorata" non trovata: ripiega sull'originale
        if (c.origSourceId && ok.has(c.origSourceId)) return [{ ...c, sourceId: c.origSourceId, enhanced: false, enhSourceId: undefined }]
        return []
      }),
    }))
    for (const c of t.flatMap((x) => x.clips)) if (c.origSourceId && c.enhSourceId && ok.has(c.enhSourceId)) enhCache.current.set(c.origSourceId, c.enhSourceId)
    // se mancano file il progetto risulta "modificato", così non si sovrascrive per sbaglio
    resetTo(t, missing.length || forceDirty ? null : t, path, Array.isArray(proj.chapters) ? proj.chapters : [])
    setTx(new Map(Object.entries(proj.transcripts ?? {}).filter(([id]) => ok.has(id))))
    const m = { ...defaultMeta(), ...(proj.meta ?? {}) }
    setMeta(m)
    setCoverUrl(m.cover ? await window.api.readCover(m.cover) : null)
    setSrcVer((v) => v + 1)
    setTimeout(fit, 60)
    if (missing.length) flash(`File audio non trovati (spostati o cancellati): ${missing.join(', ')}`)
  }

  const openProject = async (known?: string) => {
    if (!confirmDiscard()) return
    const r = await window.api.projectOpen(known)
    if (r.canceled) return
    if (r.error || !r.path || r.text == null) return flash(`Impossibile aprire il progetto: ${r.error}`)
    await loadProject(r.path, r.text)
  }

  const saveProject = async (saveAs = false) => {
    const snapshot = tracksRef.current
    const { text, first } = buildProjectText(snapshot)
    const r = await window.api.projectSave({
      path: saveAs ? null : projectPath,
      defaultName: projectPath ? projectName : meta.title.trim() || first?.replace(/\.[^.]+$/, '') || 'Il mio podcast',
      text,
    })
    if (r.canceled) return
    if (r.error || !r.path) return flash(`Salvataggio non riuscito: ${r.error}`)
    setProjectPath(r.path)
    setSaved(snapshot)
    flash('Progetto salvato ✓')
  }

  // ---------- Salvataggio automatico e recupero ----------
  const autoTimer = useRef<number | null>(null)
  const checked = useRef(false)

  useEffect(() => {
    ;(async () => {
      try {
        const r = await window.api.autosaveRead()
        if (r) {
          const pr = JSON.parse(r.text)
          if (['tidycast', 'podcast-editor'].includes(pr.app) && pr.tracks?.some((t: Track) => t.clips.length)) setRecovery({ text: r.text, mtime: r.mtime, path: pr.projectPath ?? null })
          else await window.api.autosaveClear()
        }
      } catch {}
      checked.current = true
    })()
  }, [])

  useEffect(() => {
    if (!dirty) {
      if (autoTimer.current != null) {
        clearTimeout(autoTimer.current)
        autoTimer.current = null
      }
      if (checked.current && !recovery) window.api.autosaveClear()
      return
    }
    if (!tracks.some((t) => t.clips.length) || autoTimer.current != null) return
    autoTimer.current = window.setTimeout(() => {
      autoTimer.current = null
      window.api.autosaveWrite(buildRef.current(tracksRef.current, true).text)
    }, 5000)
  }, [tracks, dirty, recovery])

  // ---------- Migliora voce ----------
  const enhCache = useRef(new Map<string, string>()) // sorgente originale -> versione migliorata

  async function ensureEnhanced(origId: string): Promise<string> {
    const hit = enhCache.current.get(origId)
    if (hit && sources.has(hit)) return hit
    const src = sources.get(origId)
    if (!src) throw new Error('Sorgente audio non trovata')
    analyze(src)
    const r = await window.api.enhance(src.path, src.thr ?? 0.01)
    if (!r.ok || !r.path) throw new Error(r.error)
    const id = await loadSource(r.path)
    sources.get(id)!.name = `${src.name.replace(/\.[^.]+$/, '')} · voce migliorata`
    enhCache.current.set(origId, id)
    return id
  }

  const setEnhance = async (ids: string[], on: boolean) => {
    const idSet = new Set(ids)
    const clips = tracksRef.current.flatMap((t) => t.clips).filter((c) => idSet.has(c.id))
    if (!clips.length) return
    try {
      if (on) {
        const origs = [...new Set(clips.map((c) => c.origSourceId ?? c.sourceId))]
        let i = 0
        for (const o of origs) {
          setBusy(`Miglioro la voce… ${origs.length > 1 ? `(${++i}/${origs.length})` : ''}`)
          await ensureEnhanced(o)
        }
      } else if (clips.some((c) => c.origSourceId && !sources.has(c.origSourceId))) {
        return flash('Il file originale non è più disponibile.')
      }
    } catch (e) {
      setBusy(null)
      return flash(`Miglioramento non riuscito: ${(e as Error).message}`)
    }
    setBusy(null)
    commit((ts) =>
      ts.map((tr) => ({
        ...tr,
        clips: tr.clips.map((c) => {
          if (!idSet.has(c.id)) return c
          const orig = c.origSourceId ?? c.sourceId
          if (on) {
            const enh = enhCache.current.get(orig)
            return enh ? { ...c, origSourceId: orig, enhSourceId: enh, sourceId: enh, enhanced: true } : c
          }
          return c.origSourceId ? { ...c, sourceId: c.origSourceId, enhanced: false } : c
        }),
      })),
    )
    if (on && ids.length > 1) flash(`Voce migliorata su ${ids.length} pezzi ✓`)
  }

  const onEnhanceClick = () => {
    if (selected) return setEnhance([selected.id], !selected.enhanced)
    const ids = tracks.filter((t) => !t.duck).flatMap((t) => t.clips.filter((c) => !c.enhanced).map((c) => c.id))
    if (!ids.length) return flash('Tutta la voce è già stata migliorata. Seleziona un pezzo per annullare il miglioramento.')
    setEnhance(ids, true)
  }

  // ---------- Rimuovi silenzi ----------
  const openSilence = () => setSilence({ level: 'medium', scope: selected ? 'selected' : 'all' })

  // ---------- Metadati ----------
  const pickCover = async () => {
    const r = await window.api.pickCover()
    if (!r) return
    setMeta((m) => ({ ...m, cover: r.path }))
    setCoverUrl(r.dataUrl)
  }

  // ---------- Uscita audio (cuffie / altoparlanti) ----------
  function applySink(ctx: AudioContext, id: string) {
    ;(ctx as unknown as { setSinkId?: (i: string) => Promise<void> }).setSinkId?.(id)?.catch(() => {})
  }
  const onOutChange = (id: string) => {
    localStorage.setItem('outId', id)
    setOutId(id)
    if (ctxRef.current) applySink(ctxRef.current, id)
  }

  const onRecStart = (listen: boolean) => {
    recAt.current = posRef.current
    if (listen && projectEnd(tracksRef.current) > 0) start(posRef.current)
  }
  const onRecDone = async (path: string, inLat: number, listened: boolean) => {
    setShowRec(false)
    pause()
    // chi parla ascoltando le cuffie risulta in ritardo (uscita + ingresso): si toglie dall'inizio
    const ctx = ctxRef.current
    const off = listened ? clamp(inLat + (ctx?.outputLatency ?? 0) + (ctx?.baseLatency ?? 0), 0, 0.35) : 0
    await importPaths([path], recAt.current, off)
  }

  // ---------- Capitoli ----------
  const addChapter = () => {
    const t = posRef.current
    if (chapters.some((c) => Math.abs(c.t - t) < 0.5)) return flash('C’è già un capitolo in questo punto.')
    setChapters((cs) => [...cs, { id: uid(), t, title: `Capitolo ${cs.length + 1}` }].sort((a, b) => a.t - b.t))
    flash(`Capitolo aggiunto a ${fmtTime(t)} — dagli un nome da “Capitoli”.`)
  }

  // ---------- Dissolvenza incrociata ----------
  const adj = selected ? prevAdjacent(tracks, selected.id) : null
  const canFade = !!adj && !isContinuous(adj.prev, adj.cur)
  const doCrossfade = () => {
    if (selected) {
      const r = canFade ? crossfade(tracksRef.current, selected.id, 0.3) : null
      if (!r) return flash('Qui non serve, o non c’è abbastanza audio di scorta per sfumare questo punto.')
      commit(() => r.tracks)
      flash(`Dissolvenza incrociata di ${fmtSec(+r.seconds.toFixed(2))} s ✓`)
      return
    }
    let ts = tracksRef.current
    let n = 0
    for (const tr of ts)
      for (const c of [...tr.clips].sort((a, b) => a.start - b.start)) {
        const a = prevAdjacent(ts, c.id)
        if (!a || isContinuous(a.prev, a.cur)) continue
        const r = crossfade(ts, c.id, 0.15)
        if (r) {
          ts = r.tracks
          n++
        }
      }
    if (!n) return flash('Non ci sono tagli da sfumare.')
    commit(() => ts)
    flash(`Sfumati ${n} ${n === 1 ? 'taglio' : 'tagli'} ✓`)
  }

  // ---------- Montaggio dal testo ----------
  useEffect(
    () =>
      window.api.onAsrProgress((d) => {
        if (asrActive.current) setAsr(d)
      }),
    [],
  )
  const openText = () => {
    setTxTrack(tracksRef.current.find((t) => t.clips.some((c) => c.id === selectedId))?.id ?? null)
    setShowText(true)
    window.api.asrStatus().then(setAsrInfo)
  }
  const txOrig = (c: Clip) => c.origSourceId ?? c.sourceId
  const txCurrent = (tracks.find((t) => t.id === txTrack && !t.duck && t.clips.length) ?? tracks.find((t) => !t.duck && t.clips.length)) ?? null
  const txMissing = !!txCurrent && txCurrent.clips.some((c) => !tx.has(txOrig(c)))
  const transcribe = async () => {
    if (!txCurrent) return
    const ids = [...new Set(txCurrent.clips.map(txOrig))].filter((id) => !tx.has(id) && sources.has(id))
    asrActive.current = true
    setAsr({ phase: asrInfo?.installed === false ? 'download' : 'load', pct: 0 })
    try {
      for (const id of ids) {
        const r = await window.api.asrTranscribe(sources.get(id)!.path)
        if (!r.ok) throw new Error(r.error)
        setTx((m) => new Map(m).set(id, r.words))
      }
      flash('Testo pronto ✓ Seleziona le parole da togliere e premi Canc.')
    } catch (e) {
      flash(`Trascrizione non riuscita: ${(e as Error).message}`)
    } finally {
      asrActive.current = false
      setAsr(null)
      window.api.asrStatus().then(setAsrInfo)
    }
  }
  const onTextCut = (_trackId: string, cuts: [number, number][], count: number) => {
    const sorted = [...cuts].sort((a, b) => b[0] - a[0])
    const only = tracksRef.current.filter((t) => !t.duck).map((t) => t.id)
    commit((ts) => sorted.reduce((r, [a, b]) => removeRange(r, a, b, true, only, 0.015), ts))
    setChapters((cs) => sorted.reduce((acc, [a, b]) => shiftChapters(acc, a, b), cs))
    flash(`Tolte ${count} ${count === 1 ? 'parola' : 'parole'} (${cuts.reduce((a, [x, y]) => a + (y - x), 0).toFixed(1)} s) ✓`)
  }

  // sempre aggiornato: serve ai listener globali registrati una sola volta
  const actRef = useRef({ openProject, importPaths })
  actRef.current = { openProject, importPaths }
  const doImport = async () => importPaths(await window.api.openDialog())
  if (import.meta.env.DEV)
    Object.assign(window, { __importPaths: importPaths, __openProject: openProject, __saveProject: saveProject, __setProjectPath: setProjectPath, __newProject: () => createProject(TEMPLATES[0]), __createProject: createProject, __templates: TEMPLATES, __tracks: () => JSON.stringify(tracks.map((t) => t.clips.map((c) => [+c.start.toFixed(2), +c.srcStart.toFixed(2), +c.duration.toFixed(2), c.fadeIn, c.fadeOut]))) })

  useEffect(() => {
    const over = (e: DragEvent) => {
      e.preventDefault()
      setDragOver(true)
    }
    const leave = (e: DragEvent) => {
      if (e.relatedTarget === null) setDragOver(false)
    }
    const drop = (e: DragEvent) => {
      e.preventDefault()
      setDragOver(false)
      const paths = [...(e.dataTransfer?.files ?? [])].map((f) => window.api.pathForFile(f)).filter(Boolean)
      const proj = paths.find((p) => /\.podcast$/i.test(p))
      if (proj) actRef.current.openProject(proj)
      else actRef.current.importPaths(paths)
    }
    window.addEventListener('dragover', over)
    window.addEventListener('dragleave', leave)
    window.addEventListener('drop', drop)
    return () => {
      window.removeEventListener('dragover', over)
      window.removeEventListener('dragleave', leave)
      window.removeEventListener('drop', drop)
    }
  }, [])

  // ---------- Export ----------
  const [preset, setPreset] = useState<Preset>('podcast')
  const [fmt, setFmt] = useState('mp3')
  const [quality, setQuality] = useState('std')
  const [normalize, setNormalize] = useState(true)
  const applyPreset = (id: Preset) => {
    setPreset(id)
    if (id === 'podcast') {
      setFmt('mp3')
      setQuality('std')
      setNormalize(true)
    } else if (id === 'max') {
      setFmt('flac')
      setNormalize(false)
    }
  }
  const cancelExport = useRef(false)

  const doExport = async () => {
    const total = projectEnd(tracksRef.current)
    if (total <= 0) return
    const first = tracksRef.current.flatMap((t) => t.clips)[0]
    const base = (first && sources.get(first.sourceId)?.name.replace(/\.[^.]+$/, '')) || 'podcast'
    localStorage.setItem('metaArtist', meta.artist)
    localStorage.setItem('metaAlbum', meta.album)
    const r = await window.api.exportBegin({ format: fmt, quality, normalize, sampleRate: SR, defaultName: meta.title.trim() || base, meta, chapters: chapters.map((c) => ({ t: c.t, title: c.title })), duration: total })
    if (r.canceled) return
    if (!r.ok) return setExportState({ progress: 0, error: r.error })
    cancelExport.current = false
    setExportState({ progress: 0 })
    pause()
    try {
      const CH = 30
      const snapshot = tracksRef.current
      for (let t0 = 0; t0 < total; t0 += CH) {
        if (cancelExport.current) {
          await window.api.exportCancel()
          setExportState(null)
          return
        }
        const len = Math.min(CH, total - t0)
        const [l, rr] = await renderChunk(snapshot, t0, len)
        const pcm = new Int16Array(l.length * 2)
        for (let i = 0; i < l.length; i++) {
          pcm[i * 2] = Math.max(-1, Math.min(1, l[i])) * 32767
          pcm[i * 2 + 1] = Math.max(-1, Math.min(1, rr[i])) * 32767
        }
        await window.api.exportChunk(pcm.buffer)
        setExportState({ progress: Math.min(1, (t0 + len) / total) })
      }
      const res = await window.api.exportEnd()
      setExportState(res.ok ? { progress: 1, done: res.filePath } : { progress: 1, error: res.error })
    } catch (e) {
      await window.api.exportCancel()
      setExportState({ progress: 0, error: (e as Error).message })
    }
  }

  // ---------- Scorciatoie ----------
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => {})
  keyRef.current = (e) => {
    const tg = e.target as HTMLElement
    if (tg.tagName === 'SELECT' || (tg.tagName === 'INPUT' && (tg as HTMLInputElement).type === 'text')) return
    if (exportState || showExport || showRec || silence || recovery || showTemplates || showChapters) return
    const mod = e.ctrlKey || e.metaKey
    const k = e.key.toLowerCase()
    if (mod && k === 's') {
      e.preventDefault()
      saveProject(e.shiftKey)
    } else if (mod && k === 'n') {
      e.preventDefault()
      newProject()
    } else if (mod && k === 'o') {
      e.preventDefault()
      openProject()
    } else if (mod && k === 'i') {
      e.preventDefault()
      doImport()
    } else if (mod && k === 'z') {
      e.preventDefault()
      e.shiftKey ? redo() : undo()
    } else if (mod && k === 'y') {
      e.preventDefault()
      redo()
    } else if (mod && k === 'e') {
      e.preventDefault()
      if (hasAudio) setShowExport(true)
    } else if (mod) return
    else if (k === ' ') {
      e.preventDefault()
      togglePlay()
    } else if (k === 's') doSplit()
    else if (k === 'm') addChapter()
    else if (k === 'delete' || k === 'backspace') {
      if (showText) return // il pannello del testo gestisce Canc da solo
      e.preventDefault()
      doDelete()
    } else if (k === '+' || k === '=') zoomTo(ppsRef.current * 1.25)
    else if (k === '-') zoomTo(ppsRef.current / 1.25)
    else if (k === 'home') seek(0)
    else if (k === 'escape') {
      setSelectedId(null)
      setRange(null)
    }
  }
  useEffect(() => {
    const f = (e: KeyboardEvent) => keyRef.current(e)
    window.addEventListener('keydown', f)
    return () => window.removeEventListener('keydown', f)
  }, [])

  const fmtInfo = FORMATS.find((f) => f.id === fmt)!
  const maxFade = selected ? selected.duration : 0

  return (
    <div className="app">
      <header className="toolbar">
        <Logo playing={playing} />
        <div className="group">
          <button className="btn" title="Nuovo progetto (Ctrl+N)" onClick={newProject}>
            Nuovo
          </button>
          <button className="btn" title="Apri progetto (Ctrl+O)" onClick={() => openProject()}>
            Apri
          </button>
          <button className="btn" title="Salva progetto (Ctrl+S) — Ctrl+Maiusc+S per “Salva con nome”" onClick={() => saveProject()}>
            Salva{dirty ? ' •' : ''}
          </button>
          <span className="pname" title={projectPath ?? ''}>
            {projectName}
          </span>
        </div>
        <div className="group">
          <button className="btn primary" title="Importa audio (Ctrl+I)" onClick={doImport}>
            <span className="ic">＋</span> Importa audio
          </button>
          <button
            className="btn"
            onClick={() => {
              pause()
              setShowRec(true)
            }}
          >
            <span className="dot" /> Registra
          </button>
          <button className="btn" disabled={!hasAudio} title="Esporta (Ctrl+E)" onClick={() => setShowExport(true)}>
            <span className="ic">⬇</span> Esporta
          </button>
        </div>
        <div className="group">
          <button className="btn icon-only" title="Annulla (Ctrl+Z)" disabled={!h.past.length} onClick={undo}>
            ↶
          </button>
          <button className="btn icon-only" title="Ripristina (Ctrl+Y)" disabled={!h.future.length} onClick={redo}>
            ↷
          </button>
        </div>
        <div className="group transport">
          <button className="btn icon-only" title="Torna all’inizio (Home)" onClick={() => seek(0)}>
            ⏮
          </button>
          <button className="btn play" disabled={!hasAudio} title="Riproduci / Pausa (Spazio)" onClick={togglePlay}>
            {playing ? '❚❚' : '▶'}
          </button>
          <span className="time">
            <span ref={timeRef}>0:00.0</span> <em>/ {fmtTime(end)}</em>
          </span>
        </div>
        <div className="group">
          <button className="btn" disabled={!hasAudio} title="Dividi l’audio nella posizione del cursore (S)" onClick={doSplit}>
            <span className="ic">✂</span> Dividi
          </button>
          <button className="btn danger" disabled={!hasAudio} title="Elimina la selezione (Canc)" onClick={doDelete}>
            <span className="ic">🗑</span> Elimina
          </button>
          <label className="check" title="Dopo l’eliminazione, l’audio successivo scorre indietro e non resta il buco">
            <input type="checkbox" checked={ripple} onChange={(e) => setRipple(e.target.checked)} /> Chiudi il vuoto
          </label>
          <button className="btn" disabled={!hasAudio} title="Segna i capitoli dell’episodio (M aggiunge un capitolo al cursore)" onClick={() => setShowChapters(true)}>
            <span className="ic">🔖</span> Capitoli{chapters.length ? ` (${chapters.length})` : ''}
          </button>
        </div>
</header>

      <main className="stage">
        <Timeline
          tracks={tracks}
          pps={pps}
          selectedId={selectedId}
          range={range}
          end={end}
          srcVer={srcVer}
          chapters={chapters}
          scrollRef={scrollRef}
          playheadRef={playheadRef}
          getPos={() => posRef.current}
          onSelect={setSelectedId}
          onRange={setRange}
          onSeek={seek}
          onZoom={onZoom}
          mark={mark}
          unmark={unmark}
          live={live}
          onTrack={onTrack}
          onAddTrack={onAddTrack}
          onRemoveTrack={onRemoveTrack}
          corner={
            <>
              <button className="btn icon-only mini" title="Riduci (-)" onClick={() => zoomTo(pps / 1.25)}>
                −
              </button>
              <button className="btn icon-only mini" title="Ingrandisci (+)" onClick={() => zoomTo(pps * 1.25)}>
                +
              </button>
              <button className="btn mini" disabled={!hasAudio} onClick={fit}>
                Adatta
              </button>
            </>
          }
        />
        {!hasAudio && (
          <div className="empty" onClick={doImport}>
            <div className="empty-card">
              <div className="empty-ic">
                <LogoMark size={76} />
              </div>
              <h2>Inizia importando un audio</h2>
              <p>Trascina qui un file (MP3, WAV, M4A, FLAC, OGG…) oppure clicca per sceglierlo.</p>
            </div>
          </div>
        )}
      </main>

      <footer className="inspector">
        {selected ? (
          <>
            <div className="ins-title">
              <strong>{sources.get(selected.sourceId)?.name}</strong>
              <span>{fmtTime(selected.duration)} di audio selezionato</span>
            </div>
            <label className="slider">
              <span>Dissolvenza in entrata</span>
              <input
                type="range"
                min={0}
                max={Math.min(15, maxFade)}
                step={0.1}
                value={selected.fadeIn}
                onPointerDown={mark}
                onChange={(e) => live((ts) => updateClip(ts, selected.id, (c) => clampFades({ ...c, fadeIn: +e.target.value })))}
              />
              <b>{selected.fadeIn.toFixed(1)} s</b>
            </label>
            <label className="slider">
              <span>Dissolvenza in uscita</span>
              <input
                type="range"
                min={0}
                max={Math.min(15, maxFade)}
                step={0.1}
                value={selected.fadeOut}
                onPointerDown={mark}
                onChange={(e) => live((ts) => updateClip(ts, selected.id, (c) => clampFades({ ...c, fadeIn: c.fadeIn, fadeOut: Math.min(+e.target.value, c.duration - c.fadeIn) })))}
              />
              <b>{selected.fadeOut.toFixed(1)} s</b>
            </label>
            <label className="slider">
              <span>Volume</span>
              <input
                type="range"
                min={0}
                max={2}
                step={0.01}
                value={selected.gain}
                onPointerDown={mark}
                onChange={(e) => live((ts) => updateClip(ts, selected.id, (c) => ({ ...c, gain: +e.target.value })))}
              />
              <b>{Math.round(selected.gain * 100)}%</b>
            </label>
            <div className="quick">
              <button className="btn sm" onClick={() => setClip(selected.id, (c) => clampFades({ ...c, fadeIn: 1.5 }))}>
                Fade in 1,5 s
              </button>
              <button className="btn sm" onClick={() => setClip(selected.id, (c) => clampFades({ ...c, fadeOut: 1.5 }))}>
                Fade out 1,5 s
              </button>
            </div>
          </>
        ) : range ? (
          <p className="hint">
            Selezionati <b>{(range.b - range.a).toFixed(1)} secondi</b> — premi <kbd>Canc</kbd> o “Elimina” per toglierli da tutte le tracce.
          </p>
        ) : (
          <p className="hint">
            Clicca su un pezzo di audio per modificarlo · trascinalo per spostarlo · trascina i bordi per accorciarlo · trascina sul righello per
            selezionare una parte da eliminare · <kbd>S</kbd> divide · <kbd>Spazio</kbd> riproduce.
          </p>
        )}
        <div className="tools">
          <button
            className={'btn sm' + (selected?.enhanced ? ' active' : '')}
            disabled={!hasAudio}
            title="Riduce il fruscio, taglia i rumori bassi e rende il volume della voce più uniforme"
            onClick={onEnhanceClick}
          >
            ✨ {selected?.enhanced ? 'Voce migliorata ✓' : selected ? 'Migliora voce' : 'Migliora voce (tutto)'}
          </button>
          <button className="btn sm" disabled={!hasAudio} title="Accorcia le pause lunghe" onClick={openSilence}>
            🔇 Rimuovi silenzi
          </button>
          <button
            className={'btn sm' + (showText ? ' active' : '')}
            disabled={!hasAudio}
            title="Trascrive la voce: per tagliare basta cancellare le parole (anche gli “ehm”)"
            onClick={() => (showText ? setShowText(false) : openText())}
          >
            📝 Montaggio dal testo
          </button>
          {(!selected || canFade) && (
            <button
              className="btn sm"
              disabled={!hasAudio}
              title="Elimina il “clic” o il salto brusco dopo un taglio sfumando i due pezzi uno nell’altro"
              onClick={doCrossfade}
            >
              〰 {selected ? 'Sfuma col precedente' : 'Sfuma i tagli'}
            </button>
          )}
        </div>
      </footer>

      {silence &&
        (() => {
          const ids =
            silence.scope === 'selected' && selected
              ? new Set([selected.id])
              : new Set(tracks.filter((t) => !t.duck && !t.muted).flatMap((t) => t.clips.map((c) => c.id)))
          const plan = planSilenceCuts(tracks, ids, silence.level)
          const total = plan.reduce((acc, c) => acc + (c.b - c.a), 0)
          return (
            <div className="modal-bg" onClick={() => setSilence(null)}>
              <div className="modal" onClick={(e) => e.stopPropagation()}>
                <h2>Rimuovi i silenzi</h2>
                <div className="field">
                  <span>Intensità</span>
                  <div className="fmts">
                    {(Object.keys(SILENCE_LEVELS) as SilenceLevel[]).map((l) => (
                      <button key={l} className={'chip lg' + (silence.level === l ? ' on' : '')} onClick={() => setSilence({ ...silence, level: l })}>
                        {LEVEL_LABEL[l]}
                      </button>
                    ))}
                  </div>
                  <small>
                    Le pause più lunghe di {fmtSec(SILENCE_LEVELS[silence.level].min)} s vengono accorciate a {fmtSec(SILENCE_LEVELS[silence.level].keep)} s: il ritmo resta naturale.
                  </small>
                </div>
                {selected && (
                  <div className="field">
                    <span>Dove</span>
                    <div className="fmts">
                      <button className={'chip lg' + (silence.scope === 'selected' ? ' on' : '')} onClick={() => setSilence({ ...silence, scope: 'selected' })}>
                        Solo il pezzo selezionato
                      </button>
                      <button className={'chip lg' + (silence.scope === 'all' ? ' on' : '')} onClick={() => setSilence({ ...silence, scope: 'all' })}>
                        Tutte le tracce voce
                      </button>
                    </div>
                  </div>
                )}
                <p className="result">
                  {plan.length ? (
                    <>
                      Verranno tolti <b>{total.toFixed(1)} secondi</b> di silenzio in <b>{plan.length}</b> {plan.length === 1 ? 'pausa' : 'pause'}.
                    </>
                  ) : (
                    'Non ho trovato pause abbastanza lunghe. Prova con un’intensità maggiore.'
                  )}
                </p>
                <small className="rec-note" style={{ textAlign: 'left' }}>
                  Puoi sempre annullare con Ctrl+Z. Le tracce di musica non vengono spostate.
                </small>
                <div className="modal-actions">
                  <button className="btn" onClick={() => setSilence(null)}>
                    Annulla
                  </button>
                  <button
                    className="btn primary"
                    disabled={!plan.length}
                    onClick={() => {
                      commit((ts) => applyCuts(ts, plan))
                      setSilence(null)
                      setSelectedId(null)
                      flash(`Tolti ${total.toFixed(1)} s di silenzio ✓`)
                    }}
                  >
                    Rimuovi silenzi
                  </button>
                </div>
              </div>
            </div>
          )
        })()}

      {recovery && (
        <div className="modal-bg">
          <div className="modal">
            <h2>Ripristinare il lavoro non salvato?</h2>
            <p>
              L’app si è chiusa con modifiche non salvate. Ho una copia automatica del {new Date(recovery.mtime).toLocaleString('it-IT')}
              {recovery.path ? ` (progetto “${recovery.path.split(/[\\/]/).pop()}”)` : ''}.
            </p>
            <div className="modal-actions">
              <button
                className="btn"
                onClick={async () => {
                  await window.api.autosaveClear()
                  setRecovery(null)
                }}
              >
                Scarta
              </button>
              <button
                className="btn primary"
                onClick={async () => {
                  const r = recovery
                  setRecovery(null)
                  await loadProject(r.path, r.text, true)
                }}
              >
                Ripristina
              </button>
            </div>
          </div>
        </div>
      )}

      {showRec && (
        <Recorder
          outId={outId}
          onOutChange={onOutChange}
          onClose={() => setShowRec(false)}
          onDone={onRecDone}
          canListen={hasAudio}
          onStart={onRecStart}
          onStop={pause}
        />
      )}
      {showText && (
        <Transcript
          tracks={tracks}
          tx={tx}
          trackId={txTrack}
          onTrackId={setTxTrack}
          asr={asr}
          installed={asrInfo?.installed ?? null}
          sizeMB={asrInfo?.sizeMB ?? 80}
          missing={txMissing}
          onTranscribe={transcribe}
          onCut={onTextCut}
          onSeek={seek}
          getPos={() => posRef.current}
          onClose={() => setShowText(false)}
        />
      )}
      {hint && !hasAudio && (
        <div className="hint-banner" onClick={() => setHint(null)}>
          💡 {hint}
        </div>
      )}

      {showTemplates && (
        <div className="modal-bg" onClick={() => setShowTemplates(false)}>
          <div className="modal wide" onClick={(e) => e.stopPropagation()}>
            <h2>Nuovo progetto</h2>
            <p className="tpl-intro">Scegli un punto di partenza: le tracce sono già nominate e impostate. Potrai sempre cambiarle.</p>
            <div className="tpls">
              {TEMPLATES.map((t) => (
                <button key={t.id} className="tpl" onClick={() => createProject(t)}>
                  <span className="tpl-ic">{t.icon}</span>
                  <b>{t.name}</b>
                  <small>{t.desc}</small>
                  <span className="tpl-tracks">
                    {t.tracks.map((x, i) => (
                      <i key={i} style={{ borderColor: COLORS[i % COLORS.length], color: COLORS[i % COLORS.length] }}>
                        {x.name}
                        {x.duck ? ' ♫' : ''}
                      </i>
                    ))}
                  </span>
                </button>
              ))}
            </div>
            <div className="modal-actions">
              <button className="btn" onClick={() => setShowTemplates(false)}>
                Annulla
              </button>
            </div>
          </div>
        </div>
      )}

      {showChapters && (
        <div className="modal-bg" onClick={() => setShowChapters(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Capitoli</h2>
            <p className="tpl-intro">
              I capitoli permettono agli ascoltatori di saltare a un argomento. Finiscono nel file esportato (MP3 e M4A). Metti il cursore dove inizia un argomento e premi “Aggiungi”.
            </p>
            <div className="chapters">
              {chapters.length === 0 && <p className="hint">Nessun capitolo. Consiglio: inizia con un capitolo a 0:00 (“Introduzione”).</p>}
              {chapters.map((c) => (
                <div className="chap" key={c.id}>
                  <button className="chip" title="Vai a questo punto" onClick={() => seek(c.t)}>
                    {fmtTime(c.t)}
                  </button>
                  <input
                    type="text"
                    value={c.title}
                    onChange={(e) => setChapters((cs) => cs.map((x) => (x.id === c.id ? { ...x, title: e.target.value } : x)))}
                  />
                  <button className="icon" title="Elimina capitolo" onClick={() => setChapters((cs) => cs.filter((x) => x.id !== c.id))}>
                    ×
                  </button>
                </div>
              ))}
            </div>
            <div className="modal-actions">
              <button
                className="btn"
                onClick={() => {
                  const t = posRef.current
                  if (chapters.some((c) => Math.abs(c.t - t) < 0.5)) return flash('C’è già un capitolo in questo punto.')
                  setChapters((cs) => [...cs, { id: uid(), t, title: cs.length ? `Capitolo ${cs.length + 1}` : 'Introduzione' }].sort((a, b) => a.t - b.t))
                }}
              >
                ＋ Aggiungi a {fmtTime(posRef.current)}
              </button>
              <button className="btn primary" onClick={() => setShowChapters(false)}>
                Fatto
              </button>
            </div>
          </div>
        </div>
      )}
      {dragOver && <div className="dropzone">Rilascia per importare l’audio</div>}
      {busy && <div className="overlay-msg">{busy}</div>}
      {toast && <div className="toast">{toast}</div>}

      {showExport && !exportState && (
        <div className="modal-bg" onClick={() => setShowExport(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Esporta il tuo audio</h2>
            <div className="field">
              <span>Cosa ti serve?</span>
              <div className="fmts">
                {PRESETS.map((pr) => (
                  <button key={pr.id} className={'chip lg' + (preset === pr.id ? ' on' : '')} onClick={() => applyPreset(pr.id)}>
                    {pr.icon} {pr.label}
                  </button>
                ))}
              </div>
              <small>{PRESETS.find((x) => x.id === preset)!.desc}</small>
            </div>
            <div className="field">
              <span>Formato</span>
              <div className="fmts">
                {FORMATS.map((f) => (
                  <button
                    key={f.id}
                    className={'chip lg' + (fmt === f.id ? ' on' : '')}
                    onClick={() => {
                      setFmt(f.id)
                      setPreset('custom')
                    }}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
              <small>{fmtInfo.hint}</small>
            </div>
            {fmtInfo.lossy && (
              <div className="field">
                <span>Qualità</span>
                <div className="fmts">
                  <button className={'chip lg' + (quality === 'std' ? ' on' : '')} onClick={() => (setQuality('std'), setPreset('custom'))}>
                    Buona (file più leggero)
                  </button>
                  <button className={'chip lg' + (quality === 'high' ? ' on' : '')} onClick={() => (setQuality('high'), setPreset('custom'))}>
                    Alta
                  </button>
                </div>
              </div>
            )}
            <label className="check big">
              <input
                type="checkbox"
                checked={normalize}
                onChange={(e) => {
                  setNormalize(e.target.checked)
                  setPreset('custom')
                }}
              />
              <div>
                <b>Volume uniforme per podcast</b> (consigliato)
                <small>Porta il volume a un livello standard, così gli ascoltatori non devono regolarlo.</small>
              </div>
            </label>
            <div className="preview">
              <div className="pv">
                <b>{fmtDur(end)}</b>
                <small>durata</small>
              </div>
              <div className="pv">
                <b>≈ {fmtSize(estimateBytes(fmt, quality, end))}</b>
                <small>dimensione stimata</small>
              </div>
              <div className="pv">
                <b>{normalize ? '−16 LUFS' : 'Originale'}</b>
                <small>volume</small>
              </div>
            </div>
            <ul className="pv-list">
              <li className={meta.title ? 'ok' : ''}>{meta.title ? `Titolo: ${meta.title}` : 'Nessun titolo dell’episodio'}</li>
              <li className={meta.cover && ['mp3', 'm4a', 'flac'].includes(fmt) ? 'ok' : ''}>
                {meta.cover ? (['mp3', 'm4a', 'flac'].includes(fmt) ? 'Copertina inclusa' : `Copertina non supportata da ${fmtInfo.label}`) : 'Nessuna copertina'}
              </li>
              <li className={chapters.length && ['mp3', 'm4a'].includes(fmt) ? 'ok' : ''}>
                {chapters.length
                  ? ['mp3', 'm4a'].includes(fmt)
                    ? `${chapters.length} ${chapters.length === 1 ? 'capitolo incluso' : 'capitoli inclusi'}`
                    : `I capitoli sono inclusi solo in MP3 e M4A`
                  : 'Nessun capitolo'}
              </li>
            </ul>
            <details className="meta" open={!!(meta.title || meta.artist || meta.album || meta.cover)}>
              <summary>Dettagli dell’episodio (facoltativo)</summary>
              <div className="meta-grid">
                <label>
                  <span>Titolo episodio</span>
                  <input type="text" value={meta.title} onChange={(e) => setMeta({ ...meta, title: e.target.value })} />
                </label>
                <label>
                  <span>Nome del podcast</span>
                  <input type="text" value={meta.album} onChange={(e) => setMeta({ ...meta, album: e.target.value })} />
                </label>
                <label>
                  <span>Autore</span>
                  <input type="text" value={meta.artist} onChange={(e) => setMeta({ ...meta, artist: e.target.value })} />
                </label>
                <div className="two">
                  <label>
                    <span>N° episodio</span>
                    <input type="text" inputMode="numeric" value={meta.track} onChange={(e) => setMeta({ ...meta, track: e.target.value })} />
                  </label>
                  <label>
                    <span>Anno</span>
                    <input type="text" inputMode="numeric" value={meta.year} onChange={(e) => setMeta({ ...meta, year: e.target.value })} />
                  </label>
                </div>
                <label className="wide">
                  <span>Descrizione</span>
                  <input type="text" value={meta.comment} onChange={(e) => setMeta({ ...meta, comment: e.target.value })} />
                </label>
              </div>
              <div className="cover-row">
                <div className="cover-thumb">{coverUrl ? <img src={coverUrl} alt="Copertina" /> : <span>Nessuna copertina</span>}</div>
                <div>
                  <button className="btn sm" onClick={pickCover}>
                    {meta.cover ? 'Cambia copertina…' : 'Scegli copertina…'}
                  </button>{' '}
                  {meta.cover && (
                    <button
                      className="btn sm"
                      onClick={() => {
                        setMeta({ ...meta, cover: null })
                        setCoverUrl(null)
                      }}
                    >
                      Rimuovi
                    </button>
                  )}
                  <small>Immagine quadrata JPG o PNG, meglio almeno 1400×1400 px.</small>
                  {meta.cover && !['mp3', 'm4a', 'flac'].includes(fmt) && <small className="warn">Con {fmtInfo.label} la copertina non può essere inclusa: scegli MP3, M4A o FLAC.</small>}
                </div>
              </div>
            </details>
            <div className="modal-actions">
              <button className="btn" onClick={() => setShowExport(false)}>
                Annulla
              </button>
              <button
                className="btn primary"
                onClick={() => {
                  setShowExport(false)
                  doExport()
                }}
              >
                Scegli dove salvare…
              </button>
            </div>
          </div>
        </div>
      )}

      {exportState && (
        <div className="modal-bg">
          <div className="modal">
            {exportState.error ? (
              <>
                <h2>Esportazione non riuscita</h2>
                <p className="err">{exportState.error}</p>
                <div className="modal-actions">
                  <button className="btn primary" onClick={() => setExportState(null)}>
                    Chiudi
                  </button>
                </div>
              </>
            ) : exportState.done ? (
              <>
                <h2>Fatto! ✓</h2>
                <p className="path">{exportState.done}</p>
                <div className="modal-actions">
                  <button className="btn" onClick={() => window.api.reveal(exportState.done!)}>
                    Mostra nella cartella
                  </button>
                  <button className="btn primary" onClick={() => setExportState(null)}>
                    Chiudi
                  </button>
                </div>
              </>
            ) : (
              <>
                <h2>Esporto…</h2>
                <div className="bar">
                  <div style={{ width: `${Math.round(exportState.progress * 100)}%` }} />
                </div>
                <p className="path">{Math.round(exportState.progress * 100)}%</p>
                <div className="modal-actions">
                  <button className="btn" onClick={() => (cancelExport.current = true)}>
                    Annulla
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
