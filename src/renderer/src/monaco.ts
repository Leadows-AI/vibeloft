// Monaco (the editor engine behind VS Code), bundled into the app so it works
// offline. This module is loaded on demand the first time an editor opens, so
// it never slows down app startup.
import { MONO, MONO_SIZE, MONO_WEIGHT, monoReady } from './fonts'
import * as monaco from 'monaco-editor'
import CssWorker from 'monaco-editor/language/css/css.worker?worker'
import EditorWorker from 'monaco-editor/editor/editor.worker?worker'
import HtmlWorker from 'monaco-editor/language/html/html.worker?worker'
import JsonWorker from 'monaco-editor/language/json/json.worker?worker'
import TsWorker from 'monaco-editor/language/typescript/ts.worker?worker'

self.MonacoEnvironment = {
  getWorker(_id: string, label: string) {
    if (label === 'json') return new JsonWorker()
    if (label === 'css' || label === 'scss' || label === 'less') return new CssWorker()
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new HtmlWorker()
    if (label === 'typescript' || label === 'javascript') return new TsWorker()
    return new EditorWorker()
  }
}

// The editor sees one file at a time without the project's node_modules, so
// "cannot find module" errors would be noise. Keep syntax errors only.
for (const defaults of [monaco.typescript.typescriptDefaults, monaco.typescript.javascriptDefaults]) {
  defaults.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: false })
  defaults.setCompilerOptions({
    target: monaco.typescript.ScriptTarget.ESNext,
    module: monaco.typescript.ModuleKind.ESNext,
    jsx: monaco.typescript.JsxEmit.ReactJSX,
    allowJs: true,
    allowNonTsExtensions: true,
    esModuleInterop: true
  })
}

monaco.editor.defineTheme('vibeloft-light', {
  base: 'vs',
  inherit: true,
  rules: [
    { token: 'comment', foreground: '6b7a73', fontStyle: 'italic' },
    { token: 'keyword', foreground: '7b3fa0' },
    { token: 'string', foreground: '2e7d57' },
    { token: 'number', foreground: 'b5651d' },
    { token: 'type', foreground: 'a3401d' }
  ],
  colors: {
    'editor.background': '#fffdf8',
    'editor.foreground': '#14171c',
    'editorLineNumber.foreground': '#b3aa98',
    'editorLineNumber.activeForeground': '#3a6b44',
    'editor.selectionBackground': '#4f8a5b33',
    'editor.lineHighlightBackground': '#f6f1e7',
    'editorCursor.foreground': '#3a6b44',
    'editorIndentGuide.background1': '#ebe4d6'
  }
})

monaco.editor.defineTheme('vibeloft-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: 'comment', foreground: '6f8279', fontStyle: 'italic' },
    { token: 'keyword', foreground: 'c792ea' },
    { token: 'string', foreground: '8fd19e' },
    { token: 'number', foreground: 'f0b27a' },
    { token: 'type', foreground: 'f78c6c' }
  ],
  colors: {
    'editor.background': '#1c2027',
    'editor.foreground': '#ede8de',
    'editorLineNumber.foreground': '#555c66',
    'editorLineNumber.activeForeground': '#8cc297',
    'editor.selectionBackground': '#7fb98a40',
    'editor.lineHighlightBackground': '#232831',
    'editorCursor.foreground': '#e8a23b',
    'editorIndentGuide.background1': '#2a3039',
    'editorWidget.background': '#232831'
  }
})

export function setEditorTheme(theme: 'dark' | 'light'): void {
  monaco.editor.setTheme(theme === 'dark' ? 'vibeloft-dark' : 'vibeloft-light')
}

export { monaco }

// Character widths are measured on first use; measure again once the bundled
// code font has loaded so the cursor and selections line up.
void monoReady.then(() => monaco.editor.remeasureFonts())
/** The code font, size and weight from Settings, for every editor. */
export function monoOptions(): { fontFamily: string; fontSize: number; fontWeight: string } {
  return { fontFamily: MONO, fontSize: MONO_SIZE, fontWeight: String(MONO_WEIGHT) }
}

// The code font, size or weight was changed in Settings: switch open editors over.
window.addEventListener('vibeloft:mono-font', () => {
  for (const e of monaco.editor.getEditors()) e.updateOptions(monoOptions())
  monaco.editor.remeasureFonts()
})

// Lets automated UI checks drive the editor (type, save) the way a user would.
;(window as unknown as { __vibeloftMonaco?: typeof monaco }).__vibeloftMonaco = monaco
