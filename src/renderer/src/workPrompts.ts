import type { QuickPrompt, WorkItem } from '../../shared/types'

// Prompts for sending a bug or feature to Claude, and the default quick prompts.

const ref = (w: WorkItem): string => `${w.kind === 'bug' ? 'Bug' : 'Feature'}${w.githubNumber ? ` (GitHub #${w.githubNumber})` : ''}: ${w.title}\n\n${w.body}`

export function workPrompt(w: WorkItem, mode: 'plan' | 'build'): string {
  if (mode === 'plan') {
    return w.kind === 'bug'
      ? `Investigate this bug. Find the root cause in the code and propose a fix, but do not change files yet.\n\n${ref(w)}`
      : `Turn this requirement into a short spec and an implementation plan for this codebase: acceptance criteria, files to change, risks. Do not change files yet.\n\n${ref(w)}`
  }
  return `${w.kind === 'bug' ? 'Fix this bug' : 'Implement this feature'} in the codebase. Keep changes focused, follow the existing code style, and run the project's tests or type check if there are any. Summarize what you changed at the end. Do not commit.\n\n${ref(w)}`
}

export const DEFAULT_PROMPTS: QuickPrompt[] = [
  { id: 'review', label: 'Review my changes', text: 'Review the uncommitted changes in this repo (git diff) for bugs, edge cases and anything I should fix before committing. Be concise and list the problems first.' },
  { id: 'tests', label: 'Write tests', text: 'Write tests for the code you just changed, run them, and fix anything that fails.' },
  { id: 'check', label: 'Type check & fix', text: "Run the project's type check, linter and tests, and fix any errors you find." },
  { id: 'explain', label: 'Explain changes', text: 'Explain what you just changed, in plain words, file by file, and anything I should test by hand.' },
  { id: 'commit', label: 'Commit & push', text: 'Commit the current changes with a clear commit message and push to the remote.' },
  // "Keep going" (not "Continue": that's the toolbar button that reopens your last conversation).
  { id: 'continue', label: 'Keep going', text: 'Continue.' }
]
