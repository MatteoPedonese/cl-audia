export const SR = 44100
export const MIN_CLIP = 0.05

export interface Source {
  id: string
  name: string
  path: string // percorso del file originale (serve per riaprire il progetto)
  buffer: AudioBuffer
  peaks: Float32Array // coppie min/max ogni `blk` campioni
  blk: number
  win?: Float32Array // livello massimo per finestre di ~12 ms (analisi voce/silenzi)
  thr?: number // soglia automatica sotto la quale si considera silenzio
}

export interface Clip {
  id: string
  sourceId: string
  srcStart: number // secondi dentro al file originale
  duration: number
  start: number // posizione sulla timeline
  fadeIn: number
  fadeOut: number
  gain: number
  // "Migliora voce": sourceId punta alla versione in uso, le altre due alle due versioni
  enhanced?: boolean
  origSourceId?: string
  enhSourceId?: string
}

export interface Track {
  id: string
  name: string
  color: string
  muted: boolean
  volume: number
  duck?: boolean // musica: si abbassa da sola quando parlano le altre tracce
  clips: Clip[]
}

export const sources = new Map<string, Source>()
export const uid = () => Math.random().toString(36).slice(2, 9)
export const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v))

// ---------- Import ----------
export function bufferFromS16(data: Uint8Array): AudioBuffer {
  const frames = Math.floor(data.byteLength / 4)
  const ab = data.buffer.slice(data.byteOffset, data.byteOffset + frames * 4)
  const i16 = new Int16Array(ab)
  const buf = new AudioBuffer({ numberOfChannels: 2, length: frames, sampleRate: SR })
  const l = buf.getChannelData(0)
  const r = buf.getChannelData(1)
  for (let i = 0; i < frames; i++) {
    l[i] = i16[i * 2] / 32768
    r[i] = i16[i * 2 + 1] / 32768
  }
  return buf
}

export function computePeaks(buf: AudioBuffer, blk = 128): Float32Array {
  const n = Math.ceil(buf.length / blk)
  const out = new Float32Array(n * 2)
  const chs = [buf.getChannelData(0), buf.getChannelData(1)]
  for (let i = 0; i < n; i++) {
    let mn = 1
    let mx = -1
    const end = Math.min(buf.length, (i + 1) * blk)
    for (const c of chs) {
      for (let j = i * blk; j < end; j++) {
        const v = c[j]
        if (v < mn) mn = v
        if (v > mx) mx = v
      }
    }
    out[i * 2] = mn
    out[i * 2 + 1] = mx
  }
  return out
}

// ---------- Inviluppo (fade + volume) ----------
export function clipGainAt(c: Clip, x: number): number {
  let g = c.gain
  if (c.fadeIn > 0 && x < c.fadeIn) g *= x / c.fadeIn
  const r = c.duration - x
  if (c.fadeOut > 0 && r < c.fadeOut) g *= r / c.fadeOut
  return Math.max(0, g)
}

export function clampFades(c: Clip): Clip {
  const fi = clamp(c.fadeIn, 0, c.duration)
  const fo = clamp(c.fadeOut, 0, Math.max(0, c.duration - fi))
  return { ...c, fadeIn: fi, fadeOut: fo }
}

// ---------- Operazioni di modifica (pure) ----------
export function projectEnd(tracks: Track[]): number {
  let e = 0
  for (const t of tracks) for (const c of t.clips) e = Math.max(e, c.start + c.duration)
  return e
}

export function splitAt(tracks: Track[], t: number, onlyId?: string | null) {
  let rightId: string | null = null
  const out = tracks.map((tr) => ({
    ...tr,
    clips: tr.clips.flatMap((c) => {
      const inside = t > c.start + 0.02 && t < c.start + c.duration - 0.02
      if ((onlyId && c.id !== onlyId) || !inside) return [c]
      const x = t - c.start
      const a = clampFades({ ...c, duration: x, fadeOut: 0 })
      const b = clampFades({ ...c, id: uid(), srcStart: c.srcStart + x, start: t, duration: c.duration - x, fadeIn: 0 })
      rightId = b.id
      return [a, b]
    }),
  }))
  return { tracks: out, rightId }
}

/**
 * Elimina l'intervallo [a,b]; con `ripple` chiude il vuoto.
 * `only`: limita l'operazione a certe tracce. `declick`: breve dissolvenza (s) ai lati del taglio.
 */
export function removeRange(tracks: Track[], a: number, b: number, ripple: boolean, only?: string[], declick = 0): Track[] {
  const len = b - a
  return tracks.map((tr) => {
    if (only && !only.includes(tr.id)) return tr
    return {
      ...tr,
      clips: tr.clips.flatMap((c) => {
        const ce = c.start + c.duration
        if (ce <= a) return [c]
        if (c.start >= b) return [ripple ? { ...c, start: c.start - len } : c]
        const res: Clip[] = []
        if (c.start < a) res.push(clampFades({ ...c, duration: a - c.start, fadeOut: declick }))
        if (ce > b) {
          const x = b - c.start
          res.push(
            clampFades({
              ...c,
              id: c.start < a ? uid() : c.id,
              srcStart: c.srcStart + x,
              start: ripple ? a : b,
              duration: ce - b,
              fadeIn: declick,
            }),
          )
        }
        return res
      }),
    }
  })
}

export function removeClip(tracks: Track[], id: string, ripple: boolean): Track[] {
  return tracks.map((tr) => {
    const c = tr.clips.find((x) => x.id === id)
    if (!c) return tr
    const ce = c.start + c.duration
    return {
      ...tr,
      clips: tr.clips
        .filter((x) => x.id !== id)
        .map((x) => (ripple && x.start >= ce - 0.001 ? { ...x, start: x.start - c.duration } : x)),
    }
  })
}

export function updateClip(tracks: Track[], id: string, fn: (c: Clip) => Clip): Track[] {
  return tracks.map((tr) => ({ ...tr, clips: tr.clips.map((c) => (c.id === id ? fn(c) : c)) }))
}

// ---------- Riproduzione / rendering ----------
/** Programma i clip su un contesto audio. `from`/`to` in secondi di timeline, `when0` = tempo del contesto per `from`. */
export function schedule(
  ctx: BaseAudioContext,
  dest: AudioNode,
  tracks: Track[],
  from: number,
  to: number,
  when0: number,
): AudioScheduledSourceNode[] {
  const nodes: AudioScheduledSourceNode[] = []
  const duck = duckEnvelope(tracks)
  for (const t of tracks) {
    if (t.muted) continue
    // musica con abbassamento automatico: un guadagno comune alla traccia, automatizzato con la curva
    let bus: AudioNode = dest
    if (t.duck && duck) {
      const dg = ctx.createGain()
      dg.gain.setValueAtTime(envAt(duck, from), when0)
      for (const p of duck) if (p.t > from && p.t < to) dg.gain.linearRampToValueAtTime(p.g, when0 + (p.t - from))
      dg.connect(dest)
      bus = dg
    }
    for (const c of t.clips) {
      const ce = c.start + c.duration
      if (ce <= from || c.start >= to) continue
      const src = sources.get(c.sourceId)
      if (!src) continue
      const x0 = Math.max(0, from - c.start)
      const x1 = Math.min(c.duration, to - c.start)
      if (x1 - x0 <= 0) continue
      const when = when0 + Math.max(0, c.start - from)
      const node = ctx.createBufferSource()
      node.buffer = src.buffer
      const g = ctx.createGain()
      g.gain.setValueAtTime(clipGainAt(c, x0) * t.volume, when)
      const pts = [c.fadeIn, c.duration - c.fadeOut].filter((p) => p > x0 && p < x1)
      for (const p of [...pts, x1]) g.gain.linearRampToValueAtTime(clipGainAt(c, p) * t.volume, when + (p - x0))
      node.connect(g).connect(bus)
      node.start(when, c.srcStart + x0, x1 - x0)
      nodes.push(node)
    }
  }
  return nodes
}

export async function renderChunk(tracks: Track[], t0: number, len: number): Promise<[Float32Array, Float32Array]> {
  const ctx = new OfflineAudioContext(2, Math.max(1, Math.round(len * SR)), SR)
  schedule(ctx, ctx.destination, tracks, t0, t0 + len, 0)
  const out = await ctx.startRendering()
  return [out.getChannelData(0), out.getChannelData(1)]
}

export function fmtTime(s: number, decimals = 1): string {
  s = Math.max(0, s)
  const m = Math.floor(s / 60)
  const sec = s - m * 60
  return `${m}:${sec.toFixed(decimals).padStart(decimals ? 3 + decimals : 2, '0')}`
}


// ---------- Analisi: voce e silenzi ----------
const WIN_BLOCKS = 4

/** Calcola (una volta sola per file) i livelli a finestre e la soglia automatica di silenzio. */
export function analyze(src: Source) {
  if (src.win) return
  const n = src.peaks.length / 2
  const nw = Math.max(1, Math.ceil(n / WIN_BLOCKS))
  const win = new Float32Array(nw)
  for (let i = 0; i < n; i++) {
    const v = Math.max(Math.abs(src.peaks[i * 2]), Math.abs(src.peaks[i * 2 + 1]))
    const w = (i / WIN_BLOCKS) | 0
    if (v > win[w]) win[w] = v
  }
  const sorted = Float32Array.from(win).sort()
  const p10 = sorted[Math.floor(nw * 0.1)] ?? 0 // rumore di fondo
  const p90 = sorted[Math.floor(nw * 0.9)] ?? 0 // voce
  src.win = win
  src.thr = clamp(Math.max(p10 * 2.5, p90 * 0.05), 0.002, 0.06)
}

const winDur = (s: Source) => (WIN_BLOCKS * s.blk) / s.buffer.sampleRate

type Run = [number, number]

/** Tratti (in secondi del file) sopra (`active`) o sotto la soglia nell'intervallo [t0,t1]. */
function runs(src: Source, t0: number, t1: number, active: boolean): Run[] {
  analyze(src)
  const win = src.win!
  const thr = src.thr!
  const wd = winDur(src)
  const i0 = Math.max(0, Math.floor(t0 / wd))
  const i1 = Math.min(win.length, Math.ceil(t1 / wd))
  const out: Run[] = []
  let st = -1
  for (let i = i0; i < i1; i++) {
    const is = win[i] >= thr === active
    if (is && st < 0) st = i
    else if (!is && st >= 0) {
      out.push([Math.max(t0, st * wd), Math.min(t1, i * wd)])
      st = -1
    }
  }
  if (st >= 0) out.push([Math.max(t0, st * wd), Math.min(t1, i1 * wd)])
  return out
}

function merge(r: Run[], gap: number): Run[] {
  const out: Run[] = []
  for (const x of r) {
    const l = out[out.length - 1]
    if (l && x[0] - l[1] < gap) l[1] = Math.max(l[1], x[1])
    else out.push([x[0], x[1]])
  }
  return out
}

// ---------- Rimozione dei silenzi ----------
export const SILENCE_LEVELS = {
  light: { min: 1.0, keep: 0.7 }, // pause oltre 1 s → 0,7 s
  medium: { min: 0.6, keep: 0.4 },
  strong: { min: 0.35, keep: 0.2 },
} as const
export type SilenceLevel = keyof typeof SILENCE_LEVELS
export interface Cut {
  a: number
  b: number
  trackId: string
}

/** Elenco dei tratti da togliere (coordinate di timeline) dai clip indicati. */
export function planSilenceCuts(tracks: Track[], clipIds: Set<string>, level: SilenceLevel): Cut[] {
  const { min, keep } = SILENCE_LEVELS[level]
  const cuts: Cut[] = []
  for (const tr of tracks)
    for (const c of tr.clips) {
      if (!clipIds.has(c.id)) continue
      const src = sources.get(c.sourceId)
      if (!src) continue
      const s0 = c.srcStart
      const s1 = c.srcStart + c.duration
      for (const [ra, rb] of runs(src, s0, s1, false)) {
        if (rb - ra < min) continue
        const atStart = ra <= s0 + 1e-3
        const atEnd = rb >= s1 - 1e-3
        if (atStart && atEnd) continue
        let ca = ra + keep / 2
        let cb = rb - keep / 2
        if (atStart) {
          ca = ra
          cb = rb - keep / 2
        } else if (atEnd) {
          ca = ra + keep / 2
          cb = rb
        }
        if (cb - ca < 0.05) continue
        cuts.push({ a: c.start + (ca - s0), b: c.start + (cb - s0), trackId: tr.id })
      }
    }
  return cuts
}

export function applyCuts(tracks: Track[], cuts: Cut[]): Track[] {
  let ts = tracks
  for (const c of [...cuts].sort((x, y) => y.a - x.a)) ts = removeRange(ts, c.a, c.b, true, [c.trackId], 0.01)
  return ts
}

// ---------- Musica che si abbassa quando si parla ----------
export interface DuckPoint {
  t: number
  g: number
}
export const DUCK_LEVEL = 0.2 // circa -14 dB
const DUCK_ATTACK = 0.35
const DUCK_RELEASE = 0.8
const duckCache = new WeakMap<Track[], DuckPoint[]>()

/** Curva di guadagno per le tracce "duck"; null se nessuna traccia la usa. */
export function duckEnvelope(tracks: Track[]): DuckPoint[] | null {
  if (!tracks.some((t) => t.duck)) return null
  const hit = duckCache.get(tracks)
  if (hit) return hit
  const iv: Run[] = []
  for (const tr of tracks) {
    if (tr.duck || tr.muted) continue
    for (const c of tr.clips) {
      const src = sources.get(c.sourceId)
      if (!src) continue
      for (const [a, b] of merge(runs(src, c.srcStart, c.srcStart + c.duration, true), 0.35))
        if (b - a >= 0.12) iv.push([c.start + (a - c.srcStart), c.start + (b - c.srcStart)])
    }
  }
  iv.sort((x, y) => x[0] - y[0])
  const pts: DuckPoint[] = []
  for (const [a, b] of merge(iv, DUCK_ATTACK + DUCK_RELEASE))
    pts.push({ t: Math.max(0, a - DUCK_ATTACK), g: 1 }, { t: a, g: DUCK_LEVEL }, { t: b, g: DUCK_LEVEL }, { t: b + DUCK_RELEASE, g: 1 })
  for (let i = 1; i < pts.length; i++) if (pts[i].t <= pts[i - 1].t) pts[i].t = pts[i - 1].t + 0.0005
  duckCache.set(tracks, pts)
  return pts
}

export function envAt(p: DuckPoint[], t: number): number {
  if (!p.length || t <= p[0].t) return 1
  const last = p[p.length - 1]
  if (t >= last.t) return last.g
  let lo = 0
  let hi = p.length - 1
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1
    if (p[m].t <= t) lo = m
    else hi = m
  }
  const k = (t - p[lo].t) / (p[hi].t - p[lo].t)
  return p[lo].g + (p[hi].g - p[lo].g) * k
}

// ---------- Dissolvenza incrociata ----------
const ADJ = 0.05 // tolleranza (s) per considerare due pezzi "attaccati"

/** Il pezzo che finisce dove inizia quello indicato (sulla stessa traccia), se c'è. */
export function prevAdjacent(tracks: Track[], id: string): { prev: Clip; cur: Clip } | null {
  for (const tr of tracks) {
    const cur = tr.clips.find((c) => c.id === id)
    if (!cur) continue
    let prev: Clip | null = null
    for (const p of tr.clips)
      if (p.id !== id && p.start < cur.start && Math.abs(p.start + p.duration - cur.start) < ADJ && (!prev || p.start > prev.start)) prev = p
    return prev ? { prev, cur } : null
  }
  return null
}

/** Sono due parti consecutive dello stesso file (nessun salto da nascondere)? */
export function isContinuous(prev: Clip, cur: Clip): boolean {
  return prev.sourceId === cur.sourceId && Math.abs(prev.srcStart + prev.duration - cur.srcStart) < 0.02
}

/**
 * Sfuma il pezzo `id` con il precedente usando l'audio "di scorta" oltre i bordi (quello tagliato):
 * le durate non cambiano di molto e non si perde sincronia. Restituisce null se non si può.
 */
export function crossfade(tracks: Track[], id: string, x = 0.3): { tracks: Track[]; seconds: number } | null {
  const adj = prevAdjacent(tracks, id)
  if (!adj) return null
  const { prev, cur } = adj
  const ps = sources.get(prev.sourceId)
  const prevHandle = ps ? ps.buffer.duration - (prev.srcStart + prev.duration) : 0
  const curHandle = Math.min(cur.srcStart, cur.start - prev.start - 0.05)
  let sec = 0
  let np = prev
  let nc = cur
  if (prevHandle >= 0.02) {
    sec = Math.min(x, prevHandle)
    np = clampFades({ ...prev, duration: prev.duration + sec, fadeOut: sec })
    nc = clampFades({ ...cur, fadeIn: sec })
  } else if (curHandle >= 0.02) {
    sec = Math.min(x, curHandle)
    nc = clampFades({ ...cur, start: cur.start - sec, srcStart: cur.srcStart - sec, duration: cur.duration + sec, fadeIn: sec })
    np = clampFades({ ...prev, fadeOut: sec })
  } else return null
  return { tracks: tracks.map((tr) => ({ ...tr, clips: tr.clips.map((c) => (c.id === prev.id ? np : c.id === cur.id ? nc : c)) })), seconds: sec }
}

// ---------- Capitoli ----------
export interface Chapter {
  id: string
  t: number // secondi di timeline
  title: string
}

/** Dopo aver tolto [a,b] chiudendo il vuoto, riposiziona i capitoli. */
export function shiftChapters(ch: Chapter[], a: number, b: number): Chapter[] {
  const len = b - a
  return ch.map((c) => (c.t <= a ? c : c.t >= b ? { ...c, t: c.t - len } : { ...c, t: a }))
}

// ---------- Trascrizione ----------
export interface Word {
  w: string
  s: number // secondi nel file originale
  e: number
}
export interface TWord {
  i: number
  w: string
  s: number // secondi di timeline
  e: number
  filler: boolean
}
const FILLER = /^(eh+m*|ehm+|uh+m*|u+hm+|um+|mh+m*|m+|hm+|ah+m+|e{2,}h*)$/i
export const isFiller = (w: string) => FILLER.test(w.toLowerCase().replace(/[^a-zàèéìòù]/gi, ''))

/** Parole della traccia, nell'ordine in cui si sentono sulla timeline (solo quelle ancora presenti nei pezzi). */
export function trackWords(track: Track, tx: Map<string, Word[]>): TWord[] {
  const out: TWord[] = []
  for (const c of [...track.clips].sort((a, b) => a.start - b.start)) {
    const ws = tx.get(c.origSourceId ?? c.sourceId)
    if (!ws) continue
    for (const w of ws) {
      const mid = (w.s + w.e) / 2
      if (mid < c.srcStart || mid >= c.srcStart + c.duration) continue
      const s = Math.max(c.start, c.start + w.s - c.srcStart)
      const e = Math.min(c.start + c.duration, c.start + w.e - c.srcStart)
      out.push({ i: out.length, w: w.w, s, e: Math.max(e, s + 0.02), filler: isFiller(w.w) })
    }
  }
  return out
}

/** Intervalli di timeline da togliere per le parole scelte (gruppi consecutivi uniti, con un piccolo margine). */
export function wordCuts(words: TWord[], picked: Set<number>): [number, number][] {
  const idx = [...picked].filter((i) => words[i]).sort((a, b) => a - b)
  const cuts: [number, number][] = []
  let k = 0
  while (k < idx.length) {
    let j = k
    while (j + 1 < idx.length && idx[j + 1] === idx[j] + 1) j++
    const first = words[idx[k]]
    const last = words[idx[j]]
    const prev = words[idx[k] - 1]
    const next = words[idx[j] + 1]
    const a = Math.max(prev ? prev.e : 0, first.s - 0.02)
    const b = Math.min(next ? next.s : Infinity, last.e + 0.02)
    if (b - a > 0.02) cuts.push([a, b])
    k = j + 1
  }
  return cuts
}
