import { RefObject, useEffect, useRef, useState } from 'react'
import { Chapter, Clip, MIN_CLIP, Track, clamp, clipGainAt, clampFades, duckEnvelope, envAt, sources } from './engine'

export const RULER = 30
export const TH = 104
const STRIP = 22

type Kind = 'move' | 'trimL' | 'trimR' | 'fadeIn' | 'fadeOut' | 'range'
export interface Range {
  a: number
  b: number
}

interface Props {
  tracks: Track[]
  pps: number
  selectedId: string | null
  range: Range | null
  end: number
  srcVer: number
  chapters: Chapter[]
  scrollRef: RefObject<HTMLDivElement | null>
  playheadRef: RefObject<HTMLDivElement | null>
  getPos: () => number
  onSelect: (id: string | null) => void
  onRange: (r: Range | null) => void
  onSeek: (t: number) => void
  onZoom: (factor: number, anchorPx: number) => void
  mark: () => void
  unmark: () => void
  live: (fn: (t: Track[]) => Track[]) => void
  onTrack: (id: string, patch: Partial<Track>) => void
  onAddTrack: () => void
  onRemoveTrack: (id: string) => void
  corner?: React.ReactNode
}

interface Drag {
  kind: Kind
  sx: number
  sy: number
  orig?: Clip
  moved: boolean
}

export default function Timeline(p: Props) {
  const { tracks, pps, selectedId, range } = p
  const cvRef = useRef<HTMLCanvasElement>(null)
  const ovRef = useRef<HTMLDivElement>(null)
  const drag = useRef<Drag | null>(null)
  const [vw, setVw] = useState(800)
  const [scrollX, setScrollX] = useState(0)

  const totalW = Math.max(vw, (p.end + 30) * pps)
  const H = RULER + tracks.length * TH

  // dimensioni viewport
  useEffect(() => {
    const el = p.scrollRef.current!
    const ro = new ResizeObserver(() => setVw(el.clientWidth))
    ro.observe(el)
    setVw(el.clientWidth)
    return () => ro.disconnect()
  }, [])

  // zoom con Ctrl + rotella
  useEffect(() => {
    const el = p.scrollRef.current!
    const h = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      p.onZoom(e.deltaY < 0 ? 1.2 : 1 / 1.2, e.clientX - rect.left)
    }
    el.addEventListener('wheel', h, { passive: false })
    return () => el.removeEventListener('wheel', h)
  }, [p.onZoom])

  // ---------- disegno ----------
  // il ridisegno è raggruppato su un solo frame: scroll e trascinamenti rapidi non lo ripetono più volte
  useEffect(() => {
    const id = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(id)
  }, [tracks, pps, scrollX, vw, selectedId, range, p.srcVer, H, p.chapters])

  function draw() {
    const cv = cvRef.current
    if (!cv) return
    const dpr = window.devicePixelRatio || 1
    const cw = Math.round(vw * dpr)
    const ch = Math.round(H * dpr)
    // ridimensionare il canvas lo svuota e rialloca la memoria: solo se serve davvero
    if (cv.width !== cw) cv.width = cw
    if (cv.height !== ch) cv.height = ch
    const g = cv.getContext('2d')!
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    const css = getComputedStyle(document.documentElement)
    const col = (n: string) => css.getPropertyValue(n).trim()
    g.clearRect(0, 0, vw, H)

    // corsie
    tracks.forEach((_, i) => {
      g.fillStyle = i % 2 ? col('--lane-b') : col('--lane-a')
      g.fillRect(0, RULER + i * TH, vw, TH)
    })

    // clip
    const duckEnv = duckEnvelope(tracks)
    tracks.forEach((tr, ti) => {
      const y = RULER + ti * TH
      for (const c of tr.clips) {
        const x0 = c.start * pps - scrollX
        const x1 = x0 + c.duration * pps
        if (x1 < -2 || x0 > vw + 2) continue
        const sel = c.id === selectedId
        const top = y + 5
        const hgt = TH - 10
        g.save()
        g.beginPath()
        g.roundRect(x0, top, Math.max(2, x1 - x0), hgt, 8)
        g.clip()
        g.globalAlpha = tr.muted ? 0.4 : 1
        g.fillStyle = tr.color + (sel ? '55' : '30')
        g.fillRect(x0, top, x1 - x0, hgt)
        // forma d'onda
        const src = sources.get(c.sourceId)
        if (src) {
          const pr = src.buffer.sampleRate / src.blk
          const n = src.peaks.length / 2
          const mid = top + STRIP + (hgt - STRIP) / 2
          const h = (hgt - STRIP - 6) / 2
          g.beginPath()
          const a = Math.max(0, Math.floor(x0))
          const b = Math.min(vw, Math.ceil(x1))
          for (let px = a; px < b; px++) {
            const lt = (px - x0) / pps
            if (lt < 0 || lt > c.duration) continue
            const i0 = Math.floor((c.srcStart + lt) * pr)
            const i1 = Math.max(i0 + 1, Math.ceil((c.srcStart + lt + 1 / pps) * pr))
            let mn = 1
            let mx = -1
            for (let i = Math.max(0, i0); i < Math.min(n, i1); i++) {
              const lo = src.peaks[i * 2]
              const hi = src.peaks[i * 2 + 1]
              if (lo < mn) mn = lo
              if (hi > mx) mx = hi
            }
            if (mx < mn) continue
            const env = Math.min(1, clipGainAt(c, lt) * (tr.duck && duckEnv ? envAt(duckEnv, c.start + lt) : 1))
            const yt = mid - Math.min(1, mx * env) * h
            const yb = mid - Math.max(-1, mn * env) * h
            g.moveTo(px + 0.5, yt)
            g.lineTo(px + 0.5, Math.max(yb, yt + 1))
          }
          g.strokeStyle = tr.color
          g.lineWidth = 1
          g.stroke()
        }
        // fade
        g.fillStyle = 'rgba(0,0,0,0.28)'
        if (c.fadeIn > 0) {
          g.beginPath()
          g.moveTo(x0, top)
          g.lineTo(x0 + c.fadeIn * pps, top)
          g.lineTo(x0, top + hgt)
          g.closePath()
          g.fill()
        }
        if (c.fadeOut > 0) {
          g.beginPath()
          g.moveTo(x1, top)
          g.lineTo(x1 - c.fadeOut * pps, top)
          g.lineTo(x1, top + hgt)
          g.closePath()
          g.fill()
        }
        // etichetta
        g.globalAlpha = 1
        g.fillStyle = col('--text')
        g.font = '600 11px system-ui, sans-serif'
        g.textBaseline = 'middle'
        g.fillText((c.enhanced ? '✨ ' : '') + (src?.name ?? ''), Math.max(x0, 0) + 10, top + STRIP / 2, Math.max(0, x1 - Math.max(x0, 0) - 16))
        g.restore()
        // bordo
        g.beginPath()
        g.roundRect(x0, top, Math.max(2, x1 - x0), hgt, 8)
        g.strokeStyle = sel ? '#fff' : tr.color + '99'
        g.lineWidth = sel ? 2 : 1
        g.stroke()
        // maniglie fade
        if (sel) {
          for (const hx of [x0 + c.fadeIn * pps, x1 - c.fadeOut * pps]) {
            g.beginPath()
            g.arc(hx, top + 11, 5, 0, Math.PI * 2)
            g.fillStyle = '#fff'
            g.fill()
            g.strokeStyle = tr.color
            g.lineWidth = 2
            g.stroke()
          }
        }
      }
    })

    // selezione intervallo
    if (range) {
      const rx0 = range.a * pps - scrollX
      const rx1 = range.b * pps - scrollX
      g.fillStyle = 'rgba(255,90,90,0.22)'
      g.fillRect(rx0, RULER, rx1 - rx0, tracks.length * TH)
      g.fillStyle = 'rgba(255,90,90,0.9)'
      g.fillRect(rx0, 0, rx1 - rx0, RULER)
      g.fillStyle = '#fff'
      g.font = '600 11px system-ui, sans-serif'
      g.textBaseline = 'middle'
      const lbl = `${(range.b - range.a).toFixed(1)} s`
      if (rx1 - rx0 > 40) g.fillText(lbl, rx0 + 6, RULER / 2)
    }

    // righello
    g.fillStyle = col('--ruler')
    g.globalCompositeOperation = 'destination-over'
    g.globalCompositeOperation = 'source-over'
    if (!range) g.fillRect(0, 0, vw, RULER)
    else {
      const rx0 = range.a * pps - scrollX
      const rx1 = range.b * pps - scrollX
      g.fillRect(0, 0, Math.max(0, rx0), RULER)
      g.fillRect(rx1, 0, vw - rx1, RULER)
    }
    const steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800]
    const step = steps.find((s) => s * pps >= 80) ?? 3600
    g.font = '11px system-ui, sans-serif'
    g.textBaseline = 'middle'
    const t0 = Math.floor(scrollX / pps / step) * step
    for (let t = t0; t * pps - scrollX < vw + 80; t += step) {
      const x = t * pps - scrollX
      g.fillStyle = col('--text-dim')
      g.fillRect(Math.round(x), RULER - 9, 1, 9)
      const m = Math.floor(t / 60)
      const s = t - m * 60
      const lbl = `${m}:${(step < 1 ? s.toFixed(1) : Math.round(s).toString()).padStart(step < 1 ? 4 : 2, '0')}`
      if (!(range && x > range.a * pps - scrollX && x < range.b * pps - scrollX)) g.fillText(lbl, x + 4, RULER / 2 - 3)
    }
    // capitoli: bandierine sul righello e linea tratteggiata sulle tracce
    for (const ch of p.chapters) {
      const x = Math.round(ch.t * pps - scrollX)
      if (x < -4 || x > vw + 200) continue
      g.save()
      g.strokeStyle = 'rgba(255,200,87,.55)'
      g.setLineDash([4, 4])
      g.beginPath()
      g.moveTo(x + 0.5, RULER)
      g.lineTo(x + 0.5, H)
      g.stroke()
      g.restore()
      g.fillStyle = '#ffc857'
      g.beginPath()
      g.moveTo(x, 0)
      g.lineTo(x + 9, 5)
      g.lineTo(x, 10)
      g.closePath()
      g.fill()
      g.fillRect(x, 0, 1.5, RULER)
      g.font = '600 10px system-ui, sans-serif'
      g.textBaseline = 'middle'
      g.fillStyle = '#ffc857'
      g.fillText(ch.title, x + 12, 23, 140)
    }
    g.fillStyle = col('--border')
    g.fillRect(0, RULER - 1, vw, 1)
  }

  // ---------- interazione ----------
  const pt = (e: { clientX: number; clientY: number }) => {
    const r = ovRef.current!.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }

  function hit(x: number, y: number) {
    if (y < RULER) return null
    const ti = Math.floor((y - RULER) / TH)
    const tr = tracks[ti]
    if (!tr) return null
    const ly = y - RULER - ti * TH - 5
    for (let i = tr.clips.length - 1; i >= 0; i--) {
      const c = tr.clips[i]
      const x0 = c.start * pps
      const x1 = x0 + c.duration * pps
      if (x < x0 - 2 || x > x1 + 2 || ly < -2 || ly > TH - 8) continue
      let zone: Kind = 'move'
      if (c.id === selectedId && ly < STRIP && Math.abs(x - (x0 + c.fadeIn * pps)) < 9) zone = 'fadeIn'
      else if (c.id === selectedId && ly < STRIP && Math.abs(x - (x1 - c.fadeOut * pps)) < 9) zone = 'fadeOut'
      else if (x - x0 < 7) zone = 'trimL'
      else if (x1 - x < 7) zone = 'trimR'
      return { c, ti, zone }
    }
    return null
  }

  const onDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    const { x, y } = pt(e)
    const h = hit(x, y)
    ovRef.current!.setPointerCapture(e.pointerId)
    if (h) {
      p.onSelect(h.c.id)
      p.onRange(null)
      p.mark()
      drag.current = { kind: h.zone, sx: x, sy: y, orig: h.c, moved: false }
    } else {
      drag.current = { kind: 'range', sx: x, sy: y, moved: false }
    }
  }

  const onMove = (e: React.PointerEvent) => {
    const { x, y } = pt(e)
    const d = drag.current
    const ov = ovRef.current!
    if (!d) {
      const h = hit(x, y)
      ov.style.cursor = !h ? (y < RULER ? 'text' : 'default') : h.zone === 'trimL' || h.zone === 'trimR' ? 'ew-resize' : h.zone === 'move' ? 'grab' : 'pointer'
      return
    }
    if (!d.moved && Math.abs(x - d.sx) < 3 && Math.abs(y - d.sy) < 3) return
    d.moved = true
    const dx = (x - d.sx) / pps
    const o = d.orig

    if (d.kind === 'range') {
      p.onSelect(null)
      const a = Math.max(0, Math.min(d.sx, x) / pps)
      const b = Math.max(0, Math.max(d.sx, x) / pps)
      p.onRange(b - a > 0.02 ? { a, b } : null)
      return
    }
    if (!o) return
    const src = sources.get(o.sourceId)
    const srcLen = src ? src.buffer.duration : o.srcStart + o.duration
    const upd = (fn: (c: Clip) => Clip) => p.live((ts) => ts.map((tr) => ({ ...tr, clips: tr.clips.map((c) => (c.id === o.id ? fn(c) : c)) })))

    if (d.kind === 'move') {
      ov.style.cursor = 'grabbing'
      const pts = [0, p.getPos()]
      for (const tr of tracks) for (const c of tr.clips) if (c.id !== o.id) pts.push(c.start, c.start + c.duration)
      let ns = Math.max(0, o.start + dx)
      let best = 8 / pps
      let adj = 0
      for (const q of pts)
        for (const off of [0, o.duration]) {
          const diff = q - (ns + off)
          if (Math.abs(diff) < best) {
            best = Math.abs(diff)
            adj = diff
          }
        }
      ns = Math.max(0, ns + adj)
      const nt = clamp(Math.floor((y - RULER) / TH), 0, tracks.length - 1)
      p.live((ts) =>
        ts.map((tr, i) => {
          const rest = tr.clips.filter((c) => c.id !== o.id)
          return i === nt ? { ...tr, clips: [...rest, { ...o, start: ns }] } : { ...tr, clips: rest }
        }),
      )
    } else if (d.kind === 'trimL') {
      const dd = clamp(dx, Math.max(-o.srcStart, -o.start), o.duration - MIN_CLIP)
      upd(() => clampFades({ ...o, srcStart: o.srcStart + dd, start: o.start + dd, duration: o.duration - dd }))
    } else if (d.kind === 'trimR') {
      const dur = clamp(o.duration + dx, MIN_CLIP, srcLen - o.srcStart)
      upd(() => clampFades({ ...o, duration: dur }))
    } else if (d.kind === 'fadeIn') {
      upd(() => ({ ...o, fadeIn: clamp(o.fadeIn + dx, 0, o.duration - o.fadeOut) }))
    } else if (d.kind === 'fadeOut') {
      upd(() => ({ ...o, fadeOut: clamp(o.fadeOut - dx, 0, o.duration - o.fadeIn) }))
    }
  }

  const onUp = (e: React.PointerEvent) => {
    const d = drag.current
    drag.current = null
    ovRef.current!.releasePointerCapture(e.pointerId)
    if (!d) return
    if (d.kind === 'range') {
      if (!d.moved) {
        p.onSelect(null)
        p.onRange(null)
        p.onSeek(Math.max(0, d.sx / pps))
      }
    } else if (!d.moved) {
      p.unmark()
      p.onSeek(Math.max(0, d.sx / pps))
    }
    ovRef.current!.style.cursor = 'default'
  }

  return (
    <div className="tl">
      <div className="heads">
        <div className="corner" style={{ height: RULER }}>
          {p.corner}
        </div>
        {tracks.map((t) => (
          <div className="head" key={t.id} style={{ height: TH, borderLeftColor: t.color }}>
            <div className="head-row">
              <input className="tname" value={t.name} onChange={(e) => p.onTrack(t.id, { name: e.target.value })} spellCheck={false} />
              {tracks.length > 1 && (
                <button className="icon sm" title="Elimina traccia" onClick={() => p.onRemoveTrack(t.id)}>
                  ×
                </button>
              )}
            </div>
            <div className="head-row">
              <button
                className={'chip' + (t.muted ? ' on' : '')}
                title={t.muted ? 'Riattiva audio' : 'Silenzia traccia'}
                onClick={() => p.onTrack(t.id, { muted: !t.muted })}
              >
                {t.muted ? 'Muto' : 'Audio'}
              </button>
              <input
                type="range"
                min={0}
                max={1.5}
                step={0.01}
                value={t.volume}
                title={`Volume traccia ${Math.round(t.volume * 100)}%`}
                onChange={(e) => p.onTrack(t.id, { volume: +e.target.value })}
              />
            </div>
            <div className="head-row">
              <button
                className={'chip' + (t.duck ? ' on' : '')}
                title="Per la musica: si abbassa da sola quando si parla sulle altre tracce e torna su nelle pause"
                onClick={() => p.onTrack(t.id, { duck: !t.duck })}
              >
                ♫ Abbassa con la voce
              </button>
            </div>
          </div>
        ))}
        <button className="add-track" onClick={p.onAddTrack}>
          + Aggiungi traccia
        </button>
      </div>
      <div className="scroller" ref={p.scrollRef} onScroll={(e) => setScrollX(e.currentTarget.scrollLeft)}>
        <div className="inner" style={{ width: totalW, height: H }}>
          <canvas ref={cvRef} className="cv" style={{ width: vw, height: H }} />
          <div ref={ovRef} className="overlay" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp}>
            <div ref={p.playheadRef} className="playhead" style={{ height: H }} />
          </div>
        </div>
      </div>
    </div>
  )
}
