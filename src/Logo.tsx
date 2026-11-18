import { useId } from 'react'

// Simbolo di Tidycast: fumetto con forma d'onda ordinata e spunta corallo ("tutto in ordine").
// Stesso disegno di build/icon.svg, senza lo sfondo arrotondato.
export function LogoMark({ size = 28 }: { size?: number }) {
  const uid = useId().replace(/:/g, '')
  return (
    <svg className="logo-mark" width={size} height={size} viewBox="0 0 100 100" aria-hidden="true">
      <defs>
        <linearGradient id={`b${uid}`} x1="0" y1="8" x2="0" y2="90" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#8dbcff" />
          <stop offset="1" stopColor="#2563eb" />
        </linearGradient>
        <linearGradient id={`c${uid}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ffa07f" />
          <stop offset="1" stopColor="#ef5a36" />
        </linearGradient>
      </defs>
      <g fill={`url(#b${uid})`}>
        <rect x="4" y="8" width="80" height="58" rx="19" />
        <path d="M18 62 L10 90 L40 64 Z" />
      </g>
      <g className="logo-bars" fill="var(--logo-bars, #0a0f24)" fillOpacity="0.92">
        <rect x="20" y="29" width="6.5" height="18" rx="3.25" />
        <rect x="31" y="22" width="6.5" height="32" rx="3.25" />
        <rect x="42" y="17" width="6.5" height="42" rx="3.25" />
        <rect x="53" y="22" width="6.5" height="32" rx="3.25" />
        <rect x="64" y="29" width="6.5" height="18" rx="3.25" />
      </g>
      <circle cx="74" cy="72" r="23" fill="var(--logo-ring, #131a36)" />
      <circle cx="74" cy="72" r="18" fill={`url(#c${uid})`} />
      <path d="M66 73 L72 79 L83 65.5" fill="none" stroke="#fff" strokeWidth="5.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

// Scritta con le cuffie intorno: "tidy" leggero, "cast" pieno con sfumatura blu (senza il simbolo).
// Con `playing` le cuffie pulsano a ritmo e partono le onde dai padiglioni.
export default function Logo({ size = 26, playing = false }: { size?: number; playing?: boolean }) {
  return (
    <span className={`logo${playing ? ' playing' : ''}`} title="Tidycast" style={{ ['--logo-size' as string]: `${size}px` }}>
      <span className="logo-band" />
      <span className="logo-cup left" />
      <span className="logo-cup right" />
      <span className="logo-word">
        <span className="logo-tidy">tidy</span>
        <span className="logo-cast">cast</span>
      </span>
    </span>
  )
}
