import { api } from './ui'

// Prettier runs inside the app (no Node or project install needed). It loads
// the first time you format, and uses the project's own Prettier settings.

const SUPPORTED = /\.(m?[jt]sx?|cjs|cts|mts|json|jsonc|css|scss|less|html?|vue|md|mdx|ya?ml|graphql|gql)$/i

export const canFormat = (path: string): boolean => SUPPORTED.test(path)

const configs = new Map<string, Promise<{ found: boolean; options: Record<string, unknown> }>>()

export function projectPrettier(projectId: string): Promise<{ found: boolean; options: Record<string, unknown> }> {
  let c = configs.get(projectId)
  if (!c) {
    c = api.prettierConfig(projectId).catch(() => ({ found: false, options: {} }))
    configs.set(projectId, c)
  }
  return c
}

/** Forget cached settings (e.g. after .prettierrc changes). */
export function resetPrettierConfig(projectId: string): void {
  configs.delete(projectId)
}

export async function formatCode(projectId: string, path: string, text: string): Promise<string> {
  const [prettier, babel, estree, typescript, postcss, html, markdown, yaml, { options }] = await Promise.all([
    import('prettier/standalone'),
    import('prettier/plugins/babel'),
    import('prettier/plugins/estree'),
    import('prettier/plugins/typescript'),
    import('prettier/plugins/postcss'),
    import('prettier/plugins/html'),
    import('prettier/plugins/markdown'),
    import('prettier/plugins/yaml'),
    projectPrettier(projectId)
  ])
  // Only plain settings from the project's config apply here (no plugins).
  const { plugins: _ignored, overrides: _overrides, ...settings } = options as Record<string, unknown>
  return prettier.format(text, {
    ...settings,
    filepath: path,
    plugins: [babel, estree, typescript, postcss, html, markdown, yaml]
  })
}
