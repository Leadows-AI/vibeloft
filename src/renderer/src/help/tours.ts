import type { ProjectTab } from '../components/ProjectView'
import type { TourId } from './topics'

// Guided tours: each step points at a part of the screen. `go` moves there
// first (a project tab, or a main view). Steps whose target isn't on screen
// (e.g. no linked projects yet) are skipped.

export interface TourStep {
  target: string
  title: string
  text: string
  go?: { project: ProjectTab } | { view: 'dashboard' | 'settings' }
}

export const TOURS: Record<TourId, { title: string; blurb: string; steps: TourStep[] }> = {
  welcome: {
    title: 'Welcome tour',
    blurb: 'The sidebar, projects and getting around (1 minute)',
    steps: [
      { target: '.brand', title: 'Welcome to Vibeloft', text: 'One place to build and manage all your customer apps with Claude. This tour shows you around in about a minute.', go: { view: 'dashboard' } },
      { target: '.nav', title: 'Your overview', text: 'Dashboard shows every project at a glance, Deliveries shows upcoming dates for all customers, Customers lists who each project is for, and Settings holds your preferences.' },
      { target: '.sidebar-section-head', title: 'Your projects', text: 'Each project is a code folder for a customer. Click + to add one: from a folder, from GitHub, or a ready-made web or mobile template.' },
      { target: '.project-list', title: 'Open a project', text: 'Click a project to open it. A pulsing dot means Claude finished or needs you there; a red number is open bugs; “API” means a linked API changed.' },
      { target: '.find-project', title: 'Jump anywhere', text: 'Click here or press Ctrl+K, then type part of a project’s name. Each project reopens on the tab you left it on.' },
      { target: '.app-tools', title: 'Help, light and dark', text: 'Top right on every screen. The ? opens help (or press F1): ask a question, take another tour, or follow the Getting started checklist. The moon or sun switches between dark and light; Settings also has System, which follows Windows.' }
    ]
  },
  project: {
    title: 'A project',
    blurb: 'The header, tabs and linked projects',
    steps: [
      { target: '.project-name', title: 'The project', text: 'Its name. Click it for the customer, GitHub repo, current branch and linked projects.', go: { project: 'overview' } },
      { target: '.timer-btn', title: 'Track time', text: 'Start and stop a timer for this project; it keeps running while you switch around.' },
      { target: '.tabs', title: 'Everything for this project', text: 'Terminal for Claude Code, Files for the code editor, Git for commits, Preview, Features & bugs and Overview. More holds Timeline, Time, Architecture and Environment.' },
      { target: '.linked-card', title: 'Link to another project', text: 'If this app uses another project’s API, link them here. Vibeloft then tells you when the API changes and updates the app with Claude.' }
    ]
  },
  terminal: {
    title: 'Terminal and Claude Code',
    blurb: 'Start Claude, prompts, undo, changes and commit',
    steps: [
      { target: '.new-menu-btn', title: 'New terminal', text: 'Continue your last Claude Code conversation, start a new one (with a mode and model if you like), resume an earlier one, open a shell or run a script. The text size is in here too.', go: { project: 'terminal' } },
      { target: '.term-tools', title: 'Terminal tools', text: 'Prompts shows one-click prompts and sends an open bug or feature to Claude. Split shows two terminals, Find searches the text, Changes lists the files Claude changed.' },
      { target: '.term-body', title: 'Talk to Claude here', text: 'Type and press Enter. Shift+Enter for a new line, Ctrl+V pastes a screenshot, drop files to insert their path, click a file path to open it. While Claude works, a Stop button appears down here.' },
      { target: '.git-bar', title: 'Commit, push and undo', text: 'Your branch and changes, what Claude just changed, and Claude’s context and usage. Commit & Push: Claude writes the message, one click commits and pushes. Undo puts your files back the way they were before any earlier prompt.' }
    ]
  },
  git: {
    title: 'Git',
    blurb: 'What to do next, diffs, commit, branches',
    steps: [
      { target: '.git-next', title: 'What to do next', text: 'This banner always tells you the next step (commit, pull, push or merge) with a button for it.', go: { project: 'git' } },
      { target: '.git-branch', title: 'Branch, pull and push', text: 'Switch or create branches, pull new commits from GitHub, and push yours.' },
      { target: '.git-commit', title: 'Commit', text: 'Write a message, or let Claude write it from your changes, then commit.' },
      { target: '.git-lists', title: 'Changed files', text: 'Click a file to see its diff. + stages it, − unstages it, and the undo arrow discards changes. Recent commits are listed below.' },
      { target: '.git-diff', title: 'Side-by-side diff', text: 'Before on the left, after on the right.' }
    ]
  }
}
