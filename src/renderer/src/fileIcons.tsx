import type { ReactNode } from 'react'
import manifest from 'material-icon-theme/dist/material-icons.json'
import { Icon } from './icons'

// File and folder icons from the Material Icon Theme (the VS Code extension's
// icon set, MIT). Each icon is its own small SVG file, loaded the first time a
// file of that type is shown.

const files = import.meta.glob('../../../node_modules/material-icon-theme/icons/*.svg', {
  eager: true,
  query: '?url',
  import: 'default'
}) as Record<string, string>
const urls = new Map(Object.entries(files).map(([path, url]) => [path.slice(path.lastIndexOf('/') + 1, -4), url]))

type Names = Record<string, string>
type Theme = {
  fileExtensions?: Names
  fileNames?: Names
  folderNames?: Names
  folderNamesExpanded?: Names
  languageIds?: Names
  file?: string
  folder?: string
  folderExpanded?: string
}
const dark = manifest as unknown as Theme & { iconDefinitions: Record<string, { iconPath: string }>; light?: Theme }

// VS Code finds most code files by their language, not their extension; these
// are the common ones the extension list leaves to the language.
const LANGUAGE: Names = {
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  jsonc: 'jsonc',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'html',
  htm: 'html',
  md: 'markdown',
  py: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  swift: 'swift',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  php: 'php',
  sh: 'shellscript',
  bash: 'shellscript',
  ps1: 'powershell',
  sql: 'sql',
  xml: 'xml',
  yml: 'yaml',
  yaml: 'yaml',
  dart: 'dart',
  vue: 'vue',
  bat: 'bat',
  lua: 'lua',
  r: 'r'
}

const url = (id: string | undefined): string | undefined => {
  const path = id && dark.iconDefinitions[id]?.iconPath
  return path ? urls.get(path.slice(path.lastIndexOf('/') + 1, -4)) : undefined
}

const isLight = (): boolean => document.documentElement.dataset.theme === 'light'

/** Look a name up in the light theme's overrides first (when light), then the default set. */
function pick(key: keyof Theme, name: string): string | undefined {
  const light = isLight() ? (dark.light?.[key] as Names | undefined)?.[name] : undefined
  return light ?? (dark[key] as Names | undefined)?.[name]
}

function fileId(name: string): string {
  const lower = name.toLowerCase()
  const byName = pick('fileNames', lower)
  if (byName) return byName
  // "app.test.tsx" tries "test.tsx", then "tsx".
  const parts = lower.split('.')
  for (let i = 1; i < parts.length; i++) {
    const ext = parts.slice(i).join('.')
    const id = pick('fileExtensions', ext) ?? (i === parts.length - 1 && LANGUAGE[ext] ? pick('languageIds', LANGUAGE[ext]) : undefined)
    if (id) return id
  }
  return (isLight() && dark.light?.file) || dark.file!
}

function folderId(name: string, open: boolean): string {
  const lower = name.toLowerCase()
  const id = pick(open ? 'folderNamesExpanded' : 'folderNames', lower)
  if (id) return id
  return open ? ((isLight() && dark.light?.folderExpanded) || dark.folderExpanded!) : (isLight() && dark.light?.folder) || dark.folder!
}

/** The icon's URL for a file, or for a folder (closed or open). */
/** One Material Icon Theme SVG by name (e.g. 'rust'), for logos outside the file tree. */
export const themeIconUrl = (name: string): string | undefined => urls.get(name)

export function iconFor(name: string, type: 'file' | 'dir', open = false): string | undefined {
  return url(type === 'dir' ? folderId(name, open) : fileId(name))
}

/**
 * The start of a file tree row: a chevron for folders (an empty slot for files,
 * so names line up) and the file type or folder icon.
 */
export function TreeIcon(props: { name: string; type: 'file' | 'dir'; open?: boolean; env?: boolean }): ReactNode {
  const src = props.env ? undefined : iconFor(props.name, props.type, props.open)
  return (
    <>
      <span className="tree-chevron">{props.type === 'dir' && <Icon name={props.open ? 'chevronDown' : 'chevronRight'} size={12} />}</span>
      {src ? (
        <img className="tree-icon" src={src} alt="" width={16} height={16} draggable={false} />
      ) : (
        <span className="tree-icon">
          <Icon name="lock" size={14} />
        </span>
      )}
    </>
  )
}
