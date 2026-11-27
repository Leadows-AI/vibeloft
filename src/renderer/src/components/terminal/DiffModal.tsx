import { useEffect, useRef, useState, type ReactNode } from 'react'
import { monaco, monoOptions, setEditorTheme } from '../../monaco'
import { api, Modal } from '../../ui'

// Side-by-side diff of one file: as it was at a checkpoint (or the last
// commit) against how it is now.

export function DiffModal(props: { projectId: string; base: string; baseLabel: string; path: string; theme: 'dark' | 'light'; onClose: () => void; onOpenFile: () => void }): ReactNode {
  const host = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [inline, setInline] = useState(false)
  const editor = useRef<monaco.editor.IStandaloneDiffEditor | null>(null)

  useEffect(() => {
    setEditorTheme(props.theme)
    if (!host.current) return
    const ed = monaco.editor.createDiffEditor(host.current, {
      readOnly: true,
      automaticLayout: true,
      renderSideBySide: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      ...monoOptions()
    })
    editor.current = ed
    let models: monaco.editor.ITextModel[] = []
    api.checkpointFile(props.projectId, props.base, props.path).then(
      ({ original, modified }) => {
        const probe = monaco.editor.createModel('', undefined, monaco.Uri.from({ scheme: 'probe', path: `/${props.path}`, query: String(Date.now()) }))
        const lang = probe.getLanguageId()
        probe.dispose()
        models = [monaco.editor.createModel(original, lang), monaco.editor.createModel(modified, lang)]
        ed.setModel({ original: models[0], modified: models[1] })
      },
      (e) => setError(String(e?.message ?? e))
    )
    return () => {
      ed.dispose()
      for (const m of models) m.dispose()
    }
  }, [props.projectId, props.base, props.path])

  useEffect(() => editor.current?.updateOptions({ renderSideBySide: !inline }), [inline])

  return (
    <Modal
      title={props.path}
      wide
      onClose={props.onClose}
      footer={
        <>
          <span className="muted small">
            Left: {props.baseLabel} · Right: now
          </span>
          <div className="grow" />
          <button className="btn" onClick={() => setInline((v) => !v)}>
            {inline ? 'Side by side' : 'Inline'}
          </button>
          <button className="btn" onClick={props.onOpenFile}>
            Open in editor
          </button>
          <button className="btn primary" onClick={props.onClose}>
            Close
          </button>
        </>
      }
    >
      {error ? <div className="notice bad">{error}</div> : <div className="diff-modal-host" ref={host} />}
    </Modal>
  )
}
