import type { CSSProperties } from 'react'

type Props = {
  min: number
  max: number
  step: number
  value: number
  /** testo mostrato dentro il pallino */
  label: string
  title?: string
  onChange: (v: number) => void
  onPointerDown?: () => void
}

/** Slider con pallino semitrasparente che mostra il valore numerico al suo interno. */
export function ValueSlider({ min, max, step, value, label, title, onChange, onPointerDown }: Props) {
  const pct = max > min ? Math.min(1, Math.max(0, (value - min) / (max - min))) : 0
  const style = { '--pct': pct } as CSSProperties
  return (
    <div className="vslider" style={style}>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        title={title}
        onPointerDown={onPointerDown}
        onChange={(e) => onChange(+e.target.value)}
      />
      <span className="vthumb">{label}</span>
    </div>
  )
}
