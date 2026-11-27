// Vibeloft's built-in guide. Each topic is short and task-focused; `screens`
// says where it's most relevant (shown first in the help panel there), and the
// same text is what "Ask Vibeloft" answers from.

export type Screen =
  | 'dashboard'
  | 'timeline'
  | 'customers'
  | 'settings'
  | 'project:overview'
  | 'project:board'
  | 'project:timeline'
  | 'project:time'
  | 'project:architecture'
  | 'project:files'
  | 'project:git'
  | 'project:preview'
  | 'project:mobile'
  | 'project:env'
  | 'project:terminal'

export interface HelpTopic {
  id: string
  title: string
  screens: Screen[]
  keywords: string
  body: string
  tour?: TourId
}

export type TourId = 'welcome' | 'project' | 'terminal' | 'git'

export const SCREEN_NAMES: Record<Screen, string> = {
  dashboard: 'Dashboard',
  timeline: 'Deliveries',
  customers: 'Customers',
  settings: 'Settings',
  'project:overview': 'a project’s Overview tab',
  'project:board': 'a project’s Features & bugs tab',
  'project:timeline': 'a project’s Timeline tab',
  'project:time': 'a project’s Time tab',
  'project:architecture': 'a project’s Architecture tab',
  'project:files': 'a project’s Files tab',
  'project:git': 'a project’s Git tab',
  'project:preview': 'a project’s Preview tab',
  'project:mobile': 'a project’s Mobile tab',
  'project:env': 'a project’s Environment tab',
  'project:terminal': 'a project’s Terminal tab'
}

export const TOPICS: HelpTopic[] = [
  {
    id: 'what-is-vibeloft',
    title: 'What Vibeloft is',
    screens: ['dashboard'],
    keywords: 'overview intro start about',
    tour: 'welcome',
    body: `Vibeloft is one place to build and manage all your customer apps with Claude. Each **project** is a code folder (usually a GitHub repo) for a customer: a web app or a mobile app. For every project you get Claude Code in a terminal, a code editor, Git, a features & bugs board, delivery dates, time tracking and customer reports. The left sidebar lists your projects grouped by customer; click one to open it.`
  },
  {
    id: 'setup',
    title: 'Install Claude Code, Git and the GitHub CLI',
    screens: ['dashboard', 'settings'],
    keywords: 'install setup claude code git github cli sign in login missing not installed',
    body: `Vibeloft needs **Claude Code** (signed in) and **Git**; the **GitHub CLI** is optional. Open **Settings → Setup → Setup check** (or **Finish setup** in the sidebar when something is missing). Each **Install** button runs the tool's official installer and shows the exact command first; **or by hand** opens the download page instead. **Sign in** opens your browser. Claude Code needs a paid Claude plan (Pro, Max, Team or Enterprise) or an Anthropic Console account.`
  },
  {
    id: 'add-project',
    title: 'Add a project',
    screens: ['dashboard'],
    keywords: 'new project create import clone github folder template',
    body: `Click **+** next to **Projects** in the sidebar. Choose where the code is:
- **On this computer**: pick an existing code folder. Vibeloft detects the type, tech stack and GitHub repository (change them under **Detected settings**).
- **On GitHub**: search every repo you can reach, including your organizations', or paste a GitHub link, then **Clone and add**. If it's already cloned in that folder, that copy is used.
- **Start fresh**: a ready-to-run **Web app** (React + Express) or **Mobile app** (Expo), with a first commit and, optionally, a private GitHub repo.
Optionally pick a customer. If something required is missing, the reason shows next to the button.`
  },
  {
    id: 'switch-projects',
    title: 'Switch between projects',
    screens: ['dashboard', 'project:overview', 'project:terminal'],
    keywords: 'switch jump ctrl+k sidebar navigate tabs remember',
    body: `Press **Ctrl+K** (⌘K on a Mac) or click **Find a project** in the sidebar, type part of a name and press **Enter**. Each project opens on the tab you last used there; the first time, it opens on **Terminal**. Terminals and Claude keep running in the background while you're in another project. A pulsing dot next to a project means Claude finished or is waiting for you there.`
  },
  {
    id: 'project-layout',
    title: 'More room: collapse the sidebar and the file tree',
    screens: ['project:overview', 'project:terminal', 'project:git'],
    keywords: 'collapse expand hide show sidebar menu rail file tree folder files panel right open folder explorer finder',
    body: `In a project, the button at the top right of the sidebar collapses it to a slim row of icons; click it again to expand it. Vibeloft remembers your choice, and the sidebar is always full size on the Dashboard, Deliveries, Customers and Settings. If Claude is waiting for you in a project while the sidebar is collapsed, the button shows a dot. On the right of every project tab (except **Files**, which has its own) is the project folder as a tree: click a folder to open it, click a file to open it in **Files**, or drag a file onto the terminal to type its path. Hide it with the button in its header and bring it back with the **Files** strip on the right. To open the project folder itself (File Explorer, or Finder on a Mac), use the open-folder button in the tree's header, **Open folder** in the project's **…** menu, or the folder name on **Overview**.`
  },
  {
    id: 'archive-delete',
    title: 'Archive or delete a project',
    screens: ['dashboard', 'project:overview'],
    keywords: 'archive restore hide delete remove project recycle bin trash',
    body: `In a project, open the **…** menu at the top right. **Archive project** hides it from the sidebar, the dashboard, project search and Deliveries, closes its terminals and stops its timer; nothing is lost. To bring it back, tick **Show archived** on the dashboard, open the project and click **Restore**. **Delete project…** removes it from Vibeloft with its features, bugs, deliveries, time and chat, and can't be undone. Tick **Also move the project folder to the Recycle Bin** (Trash on a Mac) to remove the files too; you can still get them back from there. The GitHub repository is never touched.`
  },
  {
    id: 'start-claude',
    title: 'Start Claude Code',
    screens: ['project:terminal'],
    keywords: 'claude code start terminal continue new conversation model mode plan',
    tour: 'terminal',
    body: `Projects open on the **Terminal** tab. There:
- **New conversation** starts a fresh one in a new tab. The arrow next to it lets you choose the **mode** (Normal, Auto-accept edits, Plan only), the **model**, and which **linked projects** Claude can also read.
- **Continue** reopens your last conversation. It's greyed out when that one is already open, or there isn't one yet.
- **History** reopens any earlier conversation.`
  },
  {
    id: 'talk-to-claude',
    title: 'Talk to Claude in the terminal',
    screens: ['project:terminal'],
    keywords: 'type prompt shift enter paste screenshot image drop file path stop interrupt cancel escape esc',
    body: `Type what you want and press **Enter**. **Shift+Enter** adds a new line. **Ctrl+V** pastes text or a screenshot (Claude can see images). Drag files from Explorer or Vibeloft's file tree onto the terminal to insert their path. Click a file path in Claude's output to open it in the editor at that line. When Claude asks permission, answer in the terminal (arrow keys + Enter). To stop Claude mid-reply, click the red **Stop** button (or press **Esc**): the conversation stays, so just type what to do instead.`
  },
  {
    id: 'quick-prompts',
    title: 'Quick prompts and sending bugs to Claude',
    screens: ['project:terminal', 'project:board'],
    keywords: 'quick prompt button review tests bug feature fix plan send',
    body: `Under the terminal toolbar, buttons like **Review my changes**, **Write tests** and **Commit & push** type that prompt into the open Claude session and send it. Click the **pencil** to edit, add or reorder them. **Bugs & features** lists the project's open items: **Plan** asks Claude to investigate without changing files, **Fix**/**Build** asks it to make the change.`
  },
  {
    id: 'undo',
    title: 'Undo what Claude did',
    screens: ['project:terminal'],
    keywords: 'undo revert checkpoint restore mistake rollback',
    body: `Every time you send Claude a prompt, Vibeloft saves a **checkpoint** of your files. If you don't like the result, click **Undo** in the bar after Claude's turn, or **Undo** at the bottom of the Terminal tab to pick an earlier checkpoint. Files go back exactly as they were. Your current files are saved first, so an undo can itself be undone. Commits, branches and ignored files like .env are never touched.`
  },
  {
    id: 'review-changes',
    title: 'See what Claude changed',
    screens: ['project:terminal', 'project:git'],
    keywords: 'changes diff review files changed panel',
    body: `When Claude finishes a turn, a bar shows **"Claude changed N files"** with **Review**, **Undo** and **Commit & Push**. Click **Changes** in the terminal toolbar for a live list of changed files (since your last prompt, or since the last commit); click a file for a side-by-side diff and **Open in editor**.`
  },
  {
    id: 'commit-push',
    title: 'Commit and push',
    screens: ['project:terminal', 'project:git'],
    keywords: 'commit push pull git save github message',
    tour: 'git',
    body: `At the bottom of the Terminal tab, the git bar shows the branch, the number of changes and ↑/↓. Click **Commit & Push**: Claude writes the commit message, you can edit it, then one click commits and pushes. **Pull** appears when GitHub has newer commits. The **Git** tab has a banner that always tells you the next step (commit, pull, push or merge) with a button for it.`
  },
  {
    id: 'git-tab',
    title: 'The Git tab: stage, diff, branches, merge',
    screens: ['project:git'],
    keywords: 'git stage unstage discard branch merge diff history',
    tour: 'git',
    body: `The **Git** tab lists changed files; click one for a side-by-side diff. **+** stages a file, **−** unstages it, the **undo arrow** discards changes. Write a message (or **Write with Claude**) and **Commit**. The branch menu switches or creates branches; on a branch, the banner offers **Merge into main**. If both changed the same lines, nothing is changed and it suggests asking Claude to resolve it.`
  },
  {
    id: 'history',
    title: 'Resume an earlier conversation',
    screens: ['project:terminal'],
    keywords: 'history resume previous conversation session reopen restart',
    body: `**History** in the terminal toolbar lists every Claude Code conversation in this project; search and click one to resume it with its full context. Tabs are named after their conversation. If you close Vibeloft with conversations open, the Terminal tab offers **Reopen** next time.`
  },
  {
    id: 'terminal-tools',
    title: 'Split view, find, text size, shells',
    screens: ['project:terminal'],
    keywords: 'split find search ctrl+f zoom font size rename shell run script dev server',
    body: `The **split** button splits the terminal in two (e.g. Claude and your dev server): click a pane, then a tab to show there. **Ctrl+F** finds text in the terminal. The **text size** buttons (or Ctrl − / Ctrl +) zoom the text for now; Ctrl 0 goes back to the size set in Settings › Appearance › Code font. Double-click a tab to rename it. **Shell** opens a plain terminal; **Run script** runs one of the project's npm scripts.`
  },
  {
    id: 'linked-projects',
    title: 'Linked projects (an app that uses another project’s API)',
    screens: ['project:overview', 'project:terminal'],
    keywords: 'link linked api mobile web dashboard update app add-dir',
    body: `On a project's **Overview**, **Linked projects → Link a project** says that this app uses the API of another project (or the other way round), and which files define that API. When those files change in a commit, the app gets an **API** badge and a banner. **Update app with Claude** opens Claude in the app's folder, able to read the API project's code, with a prompt listing exactly what changed. **Mark up to date** clears it. The chips under the project name switch between the two.`
  },
  {
    id: 'files-editor',
    title: 'Files and the code editor',
    screens: ['project:files'],
    keywords: 'files editor explorer open save search format prettier ctrl+p new rename delete',
    body: `The **Files** tab has a file tree and a full code editor. **Ctrl+P** opens any file by name; the search icon searches inside all files (with replace). Right-click in the tree to create, rename or delete. If a folder holds several repositories, right-click one and choose **Add as project**: it’s listed under the main project in the sidebar.**Ctrl+S** saves; **Shift+Alt+F** formats with Prettier. Files changed on disk (for example by Claude) update by themselves.`
  },
  {
    id: 'env',
    title: '.env files and secrets',
    screens: ['project:env'],
    keywords: 'env environment secrets keys variables gitignore',
    body: `The **Environment** tab shows the project's .env files with values hidden until you click. It warns if a .env file isn't ignored by git and can add it to .gitignore for you. Vibeloft never sends .env values to Claude.`
  },
  {
    id: 'board',
    title: 'Features & bugs',
    screens: ['project:board', 'project:overview'],
    keywords: 'features bugs board issues github sync priority status',
    body: `The **Features & bugs** tab is a board of the project's work (Backlog, To do, In progress, Done). Click **+ Bug** or **+ Feature** to add a bug or feature, drag cards between columns, and use **Claude** on a card to plan or fix it. **⋯ → Sync with GitHub** in the project header syncs items with the repo's GitHub Issues both ways.`
  },
  {
    id: 'deliveries',
    title: 'Deliveries and milestones',
    screens: ['timeline', 'project:timeline'],
    keywords: 'timeline milestone delivery deadline due date overdue',
    body: `Each project's **Timeline** tab holds milestones with due dates; link features and bugs to them. **Deliveries** in the sidebar shows every customer's upcoming dates in one list, with overdue warnings. Milestones sync with GitHub milestones.`
  },
  {
    id: 'time',
    title: 'Track time',
    screens: ['project:time', 'customers'],
    keywords: 'time timer hours billing rate tracking',
    body: `Click **Start timer** in a project's header; the running timer shows in the sidebar from anywhere. The **Time** tab lists entries by day and lets you add or edit them.`
  },
  {
    id: 'reports',
    title: 'Customer status reports',
    screens: ['customers', 'project:overview'],
    keywords: 'report pdf customer status email summary',
    body: `Click **⋯ → Status report** in a project's header, or **Status report** on a customer card for all their projects. Pick what to include; Claude can write a friendly summary paragraph. Save as **PDF**, copy as text, or open an email.`
  },
  {
    id: 'preview',
    title: 'Preview a web app',
    screens: ['project:preview'],
    keywords: 'preview browser localhost dev server phone tablet',
    body: `Start the dev server (for example **Run script → dev** in the Terminal), then open **Preview**: it detects the local address and shows the app, with desktop, tablet and phone widths.`
  },
  {
    id: 'claude-usage',
    title: 'Claude tokens and cost per project',
    screens: ['project:overview', 'project:terminal'],
    keywords: 'tokens cost usage spend price money billing claude usage dollars',
    body: `**Overview → Claude usage** shows how much Claude Code has been used in this project: cost and tokens for **Today**, **7 days**, **30 days** or **All time**, a 30-day chart (hover a day for its figures) and the cost per model. It counts every Claude Code conversation in the project folder, including ones started in VS Code (shown separately). In the Terminal, the footer shows the current conversation's cost next to the model. Vibeloft keeps its own record of these figures, so the history stays even after Claude Code deletes old conversations (after 30 days by default) or you move the project folder.
Cost is at Anthropic's API prices and matches Claude Code's own \`/cost\`. On a Claude plan (Pro, Max, Team) you don't pay per token, so there it shows how much was used.`
  },
  {
    id: 'mobile',
    title: 'Build and test a mobile app',
    screens: ['project:mobile'],
    keywords: 'mobile android apk build install phone device emulator adb logcat crash expo react native flutter capacitor eas',
    body: `Mobile app projects (Expo, React Native, Flutter, Capacitor or Android) get a **Mobile** tab.
- **Build APK** builds on this computer (pick Release or Debug). **For this phone** builds only for the connected phone's CPU type, several times faster with a smaller APK; **For all phones** builds every type, for sharing with testers. **Cloud build (EAS)** builds in Expo's cloud. Progress shows in a terminal; if a build fails, **Fix with Claude** hands Claude the full output.
- **Latest build** shows the version, size and when it was built. **Show in folder** to share it, **Install on device** to put it on a connected phone or emulator.
- **Devices and logs** lists connected phones (turn on USB debugging and allow this computer). **Show logs** streams the app's logs and crashes; **Send crash to Claude** gives Claude the newest crash to fix.`
  },

  {
    id: 'settings',
    title: 'Settings: theme, fonts, Claude account and model, GitHub',
    screens: ['settings'],
    keywords: 'settings appearance setup check theme dark light font fonts google model account login github format',
    body: `**Settings** has the light/dark theme, the **interface and code fonts** (type any family from fonts.google.com; it's downloaded once and works offline), format-on-save and **updates** (Appearance, Editor and Updates tabs). The **Setup** tab has three parts: **Setup check** (what's installed on this computer), **Claude Code** (your Claude account: see who's signed in, switch or sign out; and the **Claude model** used everywhere in Vibeloft) and **GitHub** (your GitHub sign-in and the default projects folder). The tiles at the top open the right part.`
  },
  {
    id: 'updates',
    title: 'Updates',
    screens: ['settings'],
    keywords: 'update updates version upgrade automatic download install portable restart',
    body: `The installed Vibeloft updates itself: shortly after it starts and every 4 hours it checks for a new version, downloads it in the background and installs it when you close Vibeloft, or straight away with **Restart to update** in the sidebar. To turn this off, untick **Check for and download updates automatically** in **Settings › About & updates**; **Check now** still works. The portable copy never updates itself: download the new one from the releases page.`
  },
  {
    id: 'help',
    title: 'Getting help',
    screens: ['dashboard', 'settings'],
    keywords: 'help f1 tour assist question',
    body: `Press **F1** or click **? Help & tour** in the sidebar. Ask a question in your own words, open a guided **tour**, or read the topics for the screen you're on. The **Getting started** checklist ticks itself off as you try each feature.`
  }
]

/** The whole guide as text, for "Ask Vibeloft". */
export function guideText(): string {
  return TOPICS.map((t) => `## [${t.id}] ${t.title}\n${t.body}`).join('\n\n')
}
