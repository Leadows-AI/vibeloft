import interLatin from '@fontsource-variable/inter/files/inter-latin-wght-normal.woff2?url'
import type { Settings } from '../../shared/types'

// Vibeloft's fonts: Inter for the interface, JetBrains Mono for the terminal,
// code, diffs, file paths and other code-like text. Both are bundled with the
// app, so it looks the same on every computer. Settings can swap either for a
// Google Fonts family, which is downloaded once and then embedded too.

const UI_STACK = "'Inter Variable', Inter, 'Segoe UI', -apple-system, BlinkMacSystemFont, system-ui, sans-serif"
/** Interface text size when none is chosen: Small (90%). */
export const UI_SCALE_DEFAULT = 0.9
const MONO_STACK = "'JetBrains Mono Variable', 'JetBrains Mono', 'Cascadia Code', Menlo, Consolas, monospace"

/** The code font stack in use. Terminals and editors read it when they open, and again on 'vibeloft:mono-font'. */
export let MONO = MONO_STACK
/** Code text size (px) and weight for terminals and editors, from Settings. */
export let MONO_SIZE = 13
export let MONO_WEIGHT = 400
/** The code size picked in Settings, or null if never picked (terminals then keep their older saved size). */
export let monoSizeSetting: number | null = null

let uiFamily: string | null = null
let uiCss = ''

/**
 * Resolves once JetBrains Mono is ready. Terminals and the code editor measure
 * character widths when they open, so they re-measure after this to keep
 * columns aligned.
 */
export const monoReady: Promise<void> = (async () => {
  try {
    await Promise.all([document.fonts.load("13px 'JetBrains Mono Variable'"), document.fonts.load("bold 13px 'JetBrains Mono Variable'")])
  } catch {
    /* falls back to the next font in MONO */
  }
})()

const applied: Record<'ui' | 'mono', string | null> = { ui: null, mono: null }

/** Switch the interface or code font to a Google Fonts family, or back to the built-in one (null). */
async function apply(kind: 'ui' | 'mono', family: string | null): Promise<void> {
  if (applied[kind] === family) return
  applied[kind] = family
  let css = ''
  if (family) {
    try {
      css = await window.vibe.googleFont(family)
    } catch {
      family = null // offline on first use, or no longer on Google Fonts: keep the built-in font
    }
  }
  const id = `font-${kind}`
  const style = document.getElementById(id) ?? document.head.appendChild(Object.assign(document.createElement('style'), { id }))
  style.textContent = css
  const stack = family ? `'${family}', ${kind === 'ui' ? UI_STACK : MONO_STACK}` : kind === 'ui' ? UI_STACK : MONO_STACK
  document.documentElement.style.setProperty(kind === 'ui' ? '--font' : '--mono', stack)
  if (kind === 'ui') {
    uiFamily = family
    uiCss = css
    return
  }
  MONO = stack
}

let monoKey = ''

/** Code font family, size and weight: terminals and editors re-measure on 'vibeloft:mono-font'. */
async function applyMono(s: Settings): Promise<void> {
  await apply('mono', s.monoFont?.trim() || null)
  const weight = s.monoFontWeight ?? 400
  const size = s.monoFontSize ?? null
  const key = `${MONO}|${size}|${weight}`
  if (key === monoKey) return
  monoKey = key
  monoSizeSetting = size
  MONO_SIZE = size ?? 13
  MONO_WEIGHT = weight
  try {
    await Promise.all([document.fonts.load(`${weight} ${MONO_SIZE}px ${MONO}`), document.fonts.load(`bold ${MONO_SIZE}px ${MONO}`)])
  } catch {
    /* measured with whatever is ready */
  }
  window.dispatchEvent(new Event('vibeloft:mono-font'))
}

// ---------- terminal colours ----------
/** The terminal's own colours for each app theme (also its text colour when none is picked). */
export const TERM_DEFAULTS = {
  dark: { bg: '#111418', fg: '#ede8de' },
  light: { bg: '#fffdf8', fg: '#14171c' }
}
/** Terminal background and text colour (#rrggbb) from Settings; null = follow the app theme / suit the background. */
export let TERM_BG: string | null = null
export let TERM_FG: string | null = null

/** WCAG relative luminance of #rrggbb. */
function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16)
  const c = [n >> 16, (n >> 8) & 255, n & 255].map((v) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
}
/** WCAG contrast ratio between two #rrggbb colours (1 to 21). */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}
/** True when light text reads better than dark text on this #rrggbb background. */
export function isDarkColor(bg: string): boolean {
  return contrastRatio(bg, TERM_DEFAULTS.dark.fg) >= contrastRatio(bg, TERM_DEFAULTS.light.fg)
}
export type ColorDefaults = typeof TERM_DEFAULTS
/** The colours in use: a picked background or the theme's, and a picked text colour or the one that suits the background. */
export function resolveColors(defs: ColorDefaults, theme: 'dark' | 'light', bg: string | null, fg: string | null): { bg: string; fg: string } {
  return { bg: bg ?? defs[theme].bg, fg: fg ?? defs[bg ? (isDarkColor(bg) ? 'dark' : 'light') : theme].fg }
}
/** The background and text colour terminals actually use, for the given app theme. */
export function termColors(theme: 'dark' | 'light', bg = TERM_BG, fg = TERM_FG): { bg: string; fg: string } {
  return resolveColors(TERM_DEFAULTS, theme, bg, fg)
}

/** The interface's own colours per theme (--bg and --text in styles.css). */
export const UI_DEFAULTS: ColorDefaults = {
  dark: { bg: '#14171c', fg: '#ede8de' },
  light: { bg: '#f6f1e7', fg: '#14171c' }
}
let uiColorKey = ''
/**
 * Interface background and text colour: override the theme's surface tokens on :root.
 * Panels, borders and muted text are mixed from the two so the whole app stays in step.
 */
function applyUiColors(bg: string | null, fg: string | null): void {
  const key = `${bg}|${fg}`
  if (key === uiColorKey) return
  uiColorKey = key
  const root = document.documentElement.style
  const B = bg ?? 'var(--theme-bg)'
  const T = fg ?? (bg ? UI_DEFAULTS[isDarkColor(bg) ? 'dark' : 'light'].fg : 'var(--theme-text)')
  const tokens: Record<string, string> = {
    '--bg': B,
    '--bg-2': `color-mix(in oklab, ${B}, ${T} 3%)`,
    '--panel': `color-mix(in oklab, ${B}, ${T} 5%)`,
    '--panel-2': `color-mix(in oklab, ${B}, ${T} 10%)`,
    '--border': `color-mix(in oklab, ${B}, ${T} 17%)`,
    '--text': T,
    '--muted': `color-mix(in oklab, ${T} 62%, ${B})`
  }
  for (const [k, v] of Object.entries(tokens)) {
    if (bg || fg) root.setProperty(k, v)
    else root.removeProperty(k)
  }
  // Native controls and scrollbars follow a picked background.
  if (bg) root.setProperty('color-scheme', isDarkColor(bg) ? 'dark' : 'light')
  else root.removeProperty('color-scheme')
}

/** Sets --term-bg/--term-fg (terminal frame, Settings preview); terminals repaint on 'vibeloft:term-colors'. */
function applyTermColors(bg: string | null, fg: string | null): void {
  if (bg === TERM_BG && fg === TERM_FG) return
  TERM_BG = bg
  TERM_FG = fg
  const root = document.documentElement.style
  if (bg) root.setProperty('--term-bg', bg)
  else root.removeProperty('--term-bg')
  const autoFg = bg ? TERM_DEFAULTS[isDarkColor(bg) ? 'dark' : 'light'].fg : null
  if (fg ?? autoFg) root.setProperty('--term-fg', (fg ?? autoFg)!)
  else root.removeProperty('--term-fg')
  window.dispatchEvent(new Event('vibeloft:term-colors'))
}

export function applyFonts(s: Settings): void {
  applyTermColors(s.terminalBg || null, s.terminalFg || null)
  applyUiColors(s.uiBg || null, s.uiFg || null)
  const root = document.documentElement.style
  root.setProperty('--ui-scale', String(s.uiFontScale ?? UI_SCALE_DEFAULT))
  root.setProperty('--ui-weight', String(s.uiFontWeight ?? 400))
  void apply('ui', s.uiFont?.trim() || null)
  void applyMono(s)
}

/** The interface font as self-contained CSS, for PDF reports (they render with no access to the app's files). */
export async function reportFont(): Promise<{ css: string; family: string }> {
  if (uiFamily) return { css: uiCss, family: `'${uiFamily}', Arial, sans-serif` }
  try {
    const blob = await (await fetch(interLatin)).blob()
    const data = await new Promise<string>((ok) => {
      const r = new FileReader()
      r.onload = () => ok(String(r.result))
      r.readAsDataURL(blob)
    })
    return {
      css: `@font-face{font-family:'Report Inter';font-weight:100 900;src:url(${data}) format('woff2')}`,
      family: "'Report Inter', Arial, sans-serif"
    }
  } catch {
    return { css: '', family: 'Arial, sans-serif' }
  }
}
