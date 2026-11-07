# Morphe – design spec

## Point of view

Morphe sits beside an editor and is glanced at, not stared at. So the chrome recedes: cool
graphite surfaces, one quiet accent, no boxes inside boxes. The one place it spends boldness is
**liveness**: when a file changes on disk, its row gets a thin accent trace on the left edge that
fades over ~1.5 s and leaves a small "updated" dot until you look at it, and the dot next to the
repo name ticks once. Everything else is still. The diff itself never animates.

What I deliberately avoided: near-black `#111` canvas with a neon accent, identical rounded cards,
ALL-CAPS eyebrow labels, monospace used for decorative labels, GitHub-saturated diff blocks.
Monospace is reserved for code; counts use the UI sans with tabular figures.

## Color tokens

Accent is a muted iris, chosen because green, red, amber and blue are already spoken for by diff
and status semantics.

| token | dark | light | use |
|---|---|---|---|
| `--bg` | `#16181D` | `#F5F6F8` | diff canvas |
| `--bg-sidebar` | `#121419` | `#ECEEF2` | sidebar, title bar |
| `--surface` | `#1D2027` | `#FFFFFF` | palette, popovers, inputs |
| `--surface-hover` | `#22262E` | `#E4E7EC` | row hover |
| `--surface-active` | `#2A2F39` | `#DCE0F5` | selected row |
| `--border` | `#272B33` | `#DCE0E6` | hairlines |
| `--text` | `#DCDFE6` | `#1C1F26` | primary text |
| `--text-muted` | `#9097A3` | `#5A616D` | secondary text, directories |
| `--text-faint` | `#767D89` | `#7A808B` | line numbers, hints (≥ 4.5:1 on its background) |
| `--accent` | `#8F8DF4` | `#5450D6` | focus ring, toggles on, live trace |
| `--add-bg` / `--add-gutter` / `--add-word` | `#18261F` / `#1D3127` / `#28533C` | `#EAF6EE` / `#D7EEDF` / `#B4E0C4` | added lines |
| `--del-bg` / `--del-gutter` / `--del-word` | `#2A1B1F` / `#362227` / `#5C2E36` | `#FCEDED` / `#F6DADC` / `#F1BEC2` | removed lines |
| `--hunk-bg` / `--hunk-text` | `#1B1E26` / `#8C93C9` | `#EEF0F8` / `#5A5F99` | hunk headers |
| status M / A / D / U / R | `#D7AB61` `#6FC79A` `#E88585` `#7DB6E3` `#C59BEA` | `#97650F` `#22804C` `#BD3B3B` `#22699F` `#7E48BD` | status glyphs |

Syntax colors are low-chroma variants that sit on both the neutral and the tinted diff
backgrounds (keywords iris, strings sage, numbers amber, comments faint, types sky).

## Type

- UI: **Geist** (variable, bundled). Code: **JetBrains Mono** (variable, bundled), ligatures off
  (`font-variant-ligatures: none`).
- Scale (px): 11 badges · 12 meta and counts · 13 base UI and file names · 14 file header path ·
  16 empty-state title · 20 welcome title. Weights 400 / 500 / 600 only.
- Code: 12.5 px on a 20 px line (1.6). Line numbers and all counts use `tabular-nums`.

## Spacing, radii, elevation, motion

- Spacing: 2, 4, 6, 8, 12, 16, 24, 32.
- Radii by hierarchy: 4 badges and chips, 6 rows, inputs and buttons, 10 palette and tooltips.
- Elevation: borders only for in-plane surfaces; one shadow token for floating layers (palette,
  tooltips).
- Motion: 140 ms ease-out for hover and toggles, 180 ms for the palette, 1.5 s decay for the live
  trace. `prefers-reduced-motion` turns all of it into instant state changes.

## Layout

```
┌──────────────────────────────────────────────────────────────────────────┐
│ ● pandas   ⎇ main     214 files  +3,412 −1,208   12/214 viewed   ─ ▢ ✕ │  title bar (drag region)
├───────────────────────┬──────────────────────────────────────────────────┤
│ [ Filter files    / ] │ M  pandas/core/ frame.py          +42 −17   ☐ │  sticky file header
│ Follow · Hide viewed  ├──────────────────────────────────────────────────┤
│ ▾ pandas/core         │ @@ -120,7 +120,9 @@ def merge(...)                │
│  M frame.py   +42 −17 │ 120 120   context                                │
│ ▍A merge.py   +8      │ 121     − removed line                           │
│  D old.py        −90  │     121 + added line                             │
│ ▾ doc                 │ ┄┄┄┄┄┄┄┄┄┄┄ 48 unchanged lines ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄ │
│  U notes.md   +12     │                                                  │
└───────────────────────┴──────────────────────────────────────────────────┘
        ↔ resizable, width persisted
```

Left aligned throughout. File rows: status glyph, filename in 500 weight, directory dimmed after
it, counts right-aligned. Staged state is a small badge (filled dot = staged, half dot = partially
staged) so it doesn't compete with the status letter.

## Components

Title bar (custom on Windows/Linux, overlay traffic lights on macOS) · branch chip · summary stats
· live dot · theme switch (system / light / dark) · sidebar (filter, toggles, file list with optional folder groups) · file row · resize
divider · sticky file header · diff view (hunk header, line row, collapsed-region separator,
notices for binary / too large / truncated) · side-by-side view (always wraps, hanging indent) ·
Markdown preview (Diff / Preview switch) · Changes / History switch · branch picker ·
commit list (summary, then short id, author and age) · selected commit header · command palette (Ctrl/Cmd+P) · tooltip
with shortcut hint · welcome screen (open folder, recent repos) · empty state ("Working tree
clean") · loading skeleton · repo-missing state.
