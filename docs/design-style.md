# Stile grafico: Aurora Blue

Scelto il 2026-11-17, tra tre proposte (Neon Studio, Sunset Pop, Aurora Blue) nate da riferimenti Pinterest.

**Mood:** blu notte con aurora blu e corallo, elegante e vivo. Animazioni morbide che danno feedback a ogni azione.

## Token (`src/styles.css`, `:root`)
| Token | Valore | Uso |
|---|---|---|
| `--bg` | `#0a0f24` | sfondo |
| `--panel` / `--panel-2` / `--panel-hover` | `#131a36` / `#1b2447` / `#243056` | pannelli, pulsanti |
| `--border` | `#243056` | bordi |
| `--text` / `--text-dim` | `#eef2ff` / `#9aa6cc` | testo |
| `--accent` / `--accent-2` | `#2563eb` / `#3b82f6` | azioni principali |
| `--coral` | `#fb7c5a` | playhead, registrazione, focus |
| `--ease` / `--spring` | `cubic-bezier(.2,.8,.2,1)` / `cubic-bezier(.34,1.56,.64,1)` | curve di movimento |

Colori tracce (`COLORS` in `src/App.tsx`): `#5b9bff #fb7c5a #34d3b0 #b28cff #ffc857 #ff7aa8`.

## Tipografia
Sora (titoli, tempo) e Inter (testo), incluse in locale con `@fontsource-variable`, quindi funzionano offline in Electron.

## Animazioni
- Sfondo con gradiente aurora che si muove lentamente.
- Pulsanti che si sollevano all'hover e si comprimono al clic; il play "respira".
- Modali e avvisi con ingresso a molla; barre di progresso con gradiente in movimento.
- Playhead corallo con alone; schermata vuota con icona che pulsa; pulsante registra che pulsa.
- `prefers-reduced-motion` disattiva tutto.

## Riferimenti
Pin Pinterest: 1149543873663897683, 1132303531308540902 (immagini solo di ispirazione, non incluse nel progetto, in `.style-research/`, escluso da git).
