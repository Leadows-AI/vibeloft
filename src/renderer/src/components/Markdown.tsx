import { marked } from 'marked'
import { useEffect, useMemo, useRef, type ReactNode } from 'react'

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

// Raw HTML inside Markdown is shown as text, never rendered.
marked.use({
  gfm: true,
  renderer: {
    html({ text }) {
      return escapeHtml(text)
    }
  }
})

let mermaidTheme: string | null = null
let counter = 0

export function Markdown({ text, theme }: { text: string; theme: 'dark' | 'light' }): ReactNode {
  const ref = useRef<HTMLDivElement>(null)
  const html = useMemo(() => marked.parse(text, { async: false }) as string, [text])

  useEffect(() => {
    const root = ref.current
    if (!root) return
    // Links open in the browser (the main process routes window.open there).
    for (const a of root.querySelectorAll('a')) {
      a.addEventListener('click', (e) => {
        e.preventDefault()
        const href = a.getAttribute('href')
        if (href && /^https?:/.test(href)) window.vibe.openUrl(href)
      })
    }
    const blocks = root.querySelectorAll<HTMLElement>('pre > code.language-mermaid')
    if (blocks.length === 0) return
    const mTheme = theme === 'dark' ? 'dark' : 'neutral'
    let cancelled = false
    import('mermaid').then(({ default: mermaid }) => {
    if (cancelled) return
    if (mermaidTheme !== mTheme) {
      mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: mTheme, fontFamily: 'inherit' })
      mermaidTheme = mTheme
    }
    blocks.forEach(async (code) => {
      const pre = code.parentElement!
      try {
        const { svg } = await mermaid.render(`mmd-${++counter}`, code.textContent ?? '')
        const holder = document.createElement('div')
        holder.className = 'mermaid-diagram'
        holder.innerHTML = svg
        pre.replaceWith(holder)
      } catch {
        pre.classList.add('mermaid-error')
        pre.title = 'This diagram has a syntax error, so it is shown as text.'
      }
    })
    })
    return () => {
      cancelled = true
    }
  }, [html, theme])

  return <div ref={ref} className="markdown" dangerouslySetInnerHTML={{ __html: html }} />
}
