import { lazy, Suspense, useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react'
import type { Checkpoint, ClaudeSession } from '../../../shared/types'
import type { AppCtx } from '../App'
import {
  attach,
  claudeTerminalFor,
  clearFind,
  closeTerminal,
  detachVisible,
  dismissProjectTurns,
  dismissTurn,
  findInTerminal,
  focusSession,
  insertIntoTerminal,
  isWaiting,
  isWorking,
  lastTurn,
  loadTerminals,
  openClaudeTask,
  openTerminal,
  refit,
  renameTerminal,
  sendToTerminal,
  setActive,
  setProjectInfo,
  stopClaude,
  useTerminals,
  zoomTerminals,
  openSessionIds
} from '../termStore'
import { claudeCommand, CONTINUED, conversationToContinue, linkedFolders, type ClaudeStart } from '../claudeStart'
import { api } from '../ui'
import type { ProjectTab } from './ProjectView'
import { LinkBanner } from './LinkedProjects'
import { addDirFlags } from '../links'
import { Icon } from '../icons'
import { ClaudeMeters, ClaudeStatusStrip } from './terminal/ClaudeStatusStrip'
import { GitBar } from './terminal/GitBar'
import { PromptBar } from './terminal/PromptBar'
import { NewMenu } from './terminal/NewMenu'
import { remember, remembered } from '../prefs'

const ChangesPanel = lazy(() => import('./terminal/ChangesPanel').then((m) => ({ default: m.ChangesPanel })))

const errText = (e: unknown): string => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

// Split view, the Changes panel and the font size are remembered per project.
const layout = new Map<string, { split: boolean; rightId: string | null; changes: boolean }>()

export function TerminalPanel({ ctx, projectId, goTab }: { ctx: AppCtx; projectId: string; goTab: (t: ProjectTab) => void }): ReactNode {
  const project = ctx.db.projects.find((p) => p.id === projectId)!
  const { list, activeId } = useTerminals(projectId)
  const leftHost = useRef<HTMLDivElement>(null)
  const rightHost = useRef<HTMLDivElement>(null)
  const [scripts, setScripts] = useState<{ label: string; command: string }[]>([])
  const saved = layout.get(projectId)
  const [split, setSplit] = useState(saved?.split ?? false)
  const [rightId, setRightId] = useState<string | null>(saved?.rightId ?? null)
  const [pane, setPane] = useState<'left' | 'right'>('left')
  const [showChanges, setShowChanges] = useState(saved?.changes ?? false)
  const [changesBase, setChangesBase] = useState('')
  const [commitOpen, setCommitOpen] = useState(false)
  const [find, setFind] = useState<{ open: boolean; q: string; miss: boolean }>({ open: false, q: '', miss: false })
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null)
  const [toast, setToast] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null)
  const [dropping, setDropping] = useState<'left' | 'right' | null>(null)
  const findBox = useRef<HTMLInputElement>(null)
  // The quick-prompt bar is hidden until you ask for it; remembered across projects and restarts.
  const [prompts, setPrompts] = useState(() => remembered('promptBar', '0') === '1')
  const togglePrompts = (): void => {
    remember('promptBar', prompts ? '0' : '1')
    setPrompts(!prompts)
  }

  // Projects linked to this one (API used or provided): Claude can read them too.
  const linked = linkedFolders(ctx.db, projectId)
  // "Continue" reopens the project's last conversation; it's off when there is
  // none, or when that one is already open in a terminal here.
  const [lastConv, setLastConv] = useState<ClaudeSession | null | undefined>(undefined)
  const [anyConv, setAnyConv] = useState(false)
  // The tab where the last conversation is already open (then Continue switches to it).
  const [lastOpenTab, setLastOpenTab] = useState<string | null>(null)
  // Conversations Claude Code actually saved (one opened but never used isn't).
  const [savedIds, setSavedIds] = useState<Map<string, string> | null>(null)
  const refreshLast = (): void => {
    void api
      .claudeSessions(projectId)
      .catch(() => [] as ClaudeSession[])
      .then((all) => {
        setAnyConv(all.length > 0)
        const latest = all.find((s) => !s.fromEditor)
        setLastOpenTab(latest ? (list.find((t) => !t.exited && t.sessionId === latest.id)?.id ?? null) : null)
        setSavedIds(new Map(all.map((s) => [s.id, (s.title || s.firstPrompt || 'a conversation').replace(/\s+/g, ' ').slice(0, 60)])))
      })
    void conversationToContinue(projectId, openSessionIds(projectId)).then(setLastConv)
  }
  // Re-check when a tab opens/closes, a conversation starts in one, or Claude ends in one.
  const termKey = list.map((t) => `${t.id}:${t.title}:${t.exited ? 1 : 0}:${t.sessionId ?? ''}:${t.claudeEnded ? 1 : 0}`).join('|')
  useEffect(refreshLast, [projectId, termKey])
  const lastName = lastConv ? (lastConv.title || lastConv.firstPrompt || 'Untitled conversation').replace(/\s+/g, ' ').trim() : ''
  const continueTitle =
    lastConv === undefined
      ? 'Looking for your last conversation…'
      : lastConv
        ? `Continue your last conversation: ${lastName.slice(0, 80)}`
        : anyConv
          ? 'Your last conversation is already open here'
          : 'No earlier Claude Code conversation in this project yet'

  const { setDb } = ctx
  const openNow = openSessionIds(projectId)
  const reopen = (ctx.db.claudeOpen?.[projectId] ?? []).filter((r) => !openNow.has(r.sessionId) && !!savedIds?.has(r.sessionId))
  const reopenNames = reopen.map((r) => savedIds?.get(r.sessionId) ?? r.title)
  const reopenAll = async (): Promise<void> => {
    const flags = addDirFlags(linked.map((l) => l.path))
    for (const r of reopen) await openTerminal(projectId, { title: CONTINUED, command: `claude --resume ${r.sessionId}${flags}` })
  }

  const right = split && rightId && rightId !== activeId && list.some((t) => t.id === rightId) ? rightId : null
  const focusedId = pane === 'right' && right ? right : activeId

  useEffect(() => {
    layout.set(projectId, { split, rightId, changes: showChanges })
  }, [projectId, split, rightId, showChanges])

  useEffect(() => {
    if (project.localPath) setProjectInfo(projectId, project.localPath, project.name)
    loadTerminals(projectId)
    api.termScripts(projectId).then(setScripts)
  }, [projectId])

  // Show the terminals and keep them sized to their panes.
  useEffect(() => {
    if (!activeId || !leftHost.current) return
    const el = leftHost.current
    attach(activeId, el, pane === 'left')
    const ro = new ResizeObserver(() => refit(activeId))
    ro.observe(el)
    return () => {
      ro.disconnect()
      detachVisible(activeId)
    }
  }, [activeId])
  useEffect(() => {
    if (!right || !rightHost.current) return
    const el = rightHost.current
    attach(right, el, pane === 'right')
    const ro = new ResizeObserver(() => refit(right))
    ro.observe(el)
    return () => {
      ro.disconnect()
      detachVisible(right)
    }
  }, [right])
  // Panes change size when the split or the Changes panel opens or closes.
  useEffect(() => {
    const t = setTimeout(() => {
      if (activeId) refit(activeId)
      if (right) refit(right)
    }, 30)
    return () => clearTimeout(t)
  }, [split, showChanges, right, activeId])

  // Ctrl+F inside a terminal opens the find bar.
  useEffect(() => {
    const onFind = (): void => {
      setFind((f) => ({ ...f, open: true }))
      setTimeout(() => findBox.current?.select(), 0)
    }
    window.addEventListener('vibeloft:terminal-find', onFind)
    return () => window.removeEventListener('vibeloft:terminal-find', onFind)
  }, [])

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), toast.tone === 'ok' ? 6000 : 12000)
    return () => clearTimeout(t)
  }, [toast])

  // ---------- actions ----------
  const startCommand = async (command: string, title: string): Promise<void> => {
    const id = await openTerminal(projectId, { title, command })
    if (pane === 'right' && split) {
      setRightId(id)
      // openTerminal made it the left one; put the previous left back.
      if (activeId) setActive(projectId, activeId)
    }
  }
  /** Start Claude Code: carry on with the last conversation or start a new one (Settings decides the default). */
  const startClaude = async (how: ClaudeStart): Promise<void> => {
    const { command, title } = await claudeCommand(ctx.db, projectId, openSessionIds(projectId), how)
    await startCommand(command, title)
  }
  const startShell = (): void => void startCommand('', 'Shell')

  /** Send a prompt to the Claude session you're looking at (or the newest one, or a new one). */
  const sendPrompt = async (text: string, title: string): Promise<void> => {
    const target = claudeTerminalFor(projectId, focusedId)
    if (target) {
      if (target !== activeId && target !== right) setActive(projectId, target)
      sendToTerminal(target, text)
    } else {
      await openClaudeTask(projectId, { title: title.slice(0, 40), prompt: text, plan: false })
    }
  }

  const undoTo = async (cp: Checkpoint): Promise<boolean> => {
    let changes
    try {
      changes = await api.checkpointChanges(projectId, cp.id)
    } catch (e) {
      setToast({ tone: 'bad', text: errText(e) })
      return false
    }
    if (changes.length === 0) {
      setToast({ tone: 'ok', text: 'Nothing to undo: the files are already the way they were then.' })
      return false
    }
    const names = changes
      .slice(0, 8)
      .map((c) => `  ${c.status === 'added' ? 'delete' : 'restore'}  ${c.path}`)
      .join('\n')
    const more = changes.length > 8 ? `\n  …and ${changes.length - 8} more` : ''
    if (
      !confirm(
        `Put ${changes.length} file${changes.length === 1 ? '' : 's'} back the way they were ${cp.label.startsWith('Before') ? cp.label.charAt(0).toLowerCase() + cp.label.slice(1) : `at "${cp.label}"`}?\n\n${names}${more}\n\nThe current files are saved as a checkpoint first, so you can undo this too. Files ignored by git (like .env and node_modules) aren't touched.`
      )
    )
      return false
    try {
      const r = await api.checkpointRestore(projectId, cp.id)
      setToast({ tone: 'ok', text: `Undone: ${r.restored} file${r.restored === 1 ? '' : 's'} restored${r.deleted ? `, ${r.deleted} new file${r.deleted === 1 ? '' : 's'} removed` : ''}. Changed your mind? Undo again and pick "Before undo…".` })
      if (focusedId) dismissTurn(focusedId)
      return true
    } catch (e) {
      setToast({ tone: 'bad', text: errText(e) })
      return false
    }
  }

  const onDrop = (e: DragEvent, side: 'left' | 'right'): void => {
    e.preventDefault()
    setDropping(null)
    const id = side === 'right' ? right : activeId
    if (!id) return
    const paths: string[] = []
    const fromTree = e.dataTransfer.getData('text/vibeloft-path')
    if (fromTree) paths.push(fromTree)
    for (const f of Array.from(e.dataTransfer.files)) {
      const p = api.pathForFile(f)
      if (p) paths.push(p)
    }
    if (!paths.length) {
      const text = e.dataTransfer.getData('text/plain')
      if (text) insertIntoTerminal(id, text)
      return
    }
    insertIntoTerminal(id, `${paths.map((p) => (/\s/.test(p) ? `"${p}"` : p)).join(' ')} `)
  }

  const pickTab = (id: string): void => {
    if (split && pane === 'right') {
      if (id === activeId) return setPane('left')
      setRightId(id)
      focusSession(id)
    } else {
      if (id === right) return setPane('right')
      setActive(projectId, id)
    }
  }

  const toggleSplit = async (): Promise<void> => {
    if (split) {
      setSplit(false)
      setPane('left')
      return
    }
    setSplit(true)
    const other = [...list].reverse().find((t) => t.id !== activeId)
    if (other) setRightId(other.id)
    else {
      // Nothing to show on the right yet: open a shell there.
      const prev = activeId
      const id = await openTerminal(projectId, { title: 'Shell' })
      setRightId(id)
      if (prev) setActive(projectId, prev)
    }
    setPane('right')
  }

  const runFind = (backwards = false): void => {
    if (!focusedId) return
    const ok = findInTerminal(focusedId, find.q, backwards)
    setFind((f) => ({ ...f, miss: !!f.q && !ok }))
  }
  const closeFind = (): void => {
    if (focusedId) {
      clearFind(focusedId)
      focusSession(focusedId)
    }
    setFind({ open: false, q: find.q, miss: false })
  }

  if (!project.localPath) {
    return (
      <div className="empty">
        <h3>No local folder</h3>
        <p>Terminals open in the project's folder. Edit the project and choose its folder first.</p>
      </div>
    )
  }

  const turn = lastTurn(focusedId)
  const showTurn = turn && !turn.dismissed && turn.changes.length > 0
  const hasClaude = !!claudeTerminalFor(projectId, focusedId)

  const paneView = (side: 'left' | 'right', id: string | null): ReactNode => (
    <div
      className={`term-pane ${split && pane === side ? 'focused' : ''} ${dropping === side ? 'dropping' : ''}`}
      onMouseDown={() => setPane(side)}
      onDragOver={(e) => {
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
        if (dropping !== side) setDropping(side)
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropping(null)
      }}
      onDrop={(e) => onDrop(e, side)}
    >
      {split && <div className="term-pane-label">{list.find((t) => t.id === id)?.title ?? 'Pick a tab above'}</div>}
      {id ? <div className="term-screen" ref={side === 'left' ? leftHost : rightHost} /> : <div className="term-pane-empty muted small">Click a tab above to show it here.</div>}
      {dropping === side && <div className="drop-hint">Drop to insert the file path</div>}
      {id && isWorking(id) && (
        <div className="claude-working">
          <span className="working-dot" />
          <span>Claude is working…</span>
          <button
            className="btn small-btn stop-claude"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={() => stopClaude(id)}
            title="Stop Claude's current reply. The conversation stays: type what to do instead."
          >
            <Icon name="stop" size={13} /> Stop <kbd>Esc</kbd>
          </button>
        </div>
      )}
    </div>
  )

  return (
    <div className="terminal-panel">
      <div className="term-bar">
        {list.length > 0 && (
          <div className="term-tabs">
            {list.map((t) => (
              <div
                key={t.id}
                className={`term-tab ${t.id === activeId ? 'on' : ''} ${t.id === right ? 'on-right' : ''} ${t.exited ? 'exited' : ''}`}
                onClick={() => pickTab(t.id)}
                onDoubleClick={() => setRenaming({ id: t.id, title: t.title })}
                title={`${t.claudeEnded ? 'Claude Code has ended here; this is now a plain shell.\n' : ''}${t.conversation ? `Conversation: ${t.conversation}\n` : ''}${t.command ?? 'Shell'}\n(double-click to rename)`}
              >
                <span
                  className={`term-dot ${t.exited ? '' : isWaiting(t.id) ? 'waiting' : 'live'}`}
                  title={isWaiting(t.id) ? 'Claude finished or is waiting for you' : t.exited ? 'Exited' : 'Running'}
                />
                {renaming?.id === t.id ? (
                  <input
                    className="term-rename"
                    autoFocus
                    value={renaming.title}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => setRenaming({ id: t.id, title: e.target.value })}
                    onBlur={() => {
                      renameTerminal(t.id, renaming.title)
                      setRenaming(null)
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') e.currentTarget.blur()
                      if (e.key === 'Escape') setRenaming(null)
                    }}
                  />
                ) : (
                  <span className="term-tab-title">{t.title}</span>
                )}
                {split && t.id === right && <span className="term-side">R</span>}
                <button
                  className="term-close"
                  aria-label={`Close ${t.title}`}
                  onClick={(e) => {
                    e.stopPropagation()
                    if (t.exited || confirm(`Close "${t.title}"? Anything running in it will be stopped.`)) closeTerminal(t.id)
                  }}
                >
                  <Icon name="close" size={13} />
                </button>
              </div>
            ))}
          </div>
        )}
        <NewMenu
          projectId={projectId}
          linked={linked}
          lastName={lastConv ? lastName : null}
          lastOpen={!lastConv && !!lastOpenTab}
          continueTitle={continueTitle}
          onOpen={refreshLast}
          reopen={reopenNames}
          scripts={scripts}
          findLast={() => conversationToContinue(projectId, openSessionIds(projectId))}
          onContinue={() => (!lastConv && lastOpenTab ? pickTab(lastOpenTab) : void startClaude('continue'))}
          onNew={() => void startClaude('new')}
          onReopen={() => void reopenAll()}
          onShell={startShell}
          onStart={(command, title) => void startCommand(command, title)}
          onResume={(s) => void startCommand(`claude --resume ${s.id}`, CONTINUED)}
          onZoom={zoomTerminals}
        />
        <div className="grow" />
        <div className="term-tools">
          <button className={`btn small-btn ${prompts ? 'on' : ''}`} onClick={togglePrompts} title="Show the quick prompts and the bugs & features picker" aria-pressed={prompts}>
            <Icon name="sparkle" size={15} /> Prompts
          </button>
          <button
            className={`icon-btn ${split ? 'on' : ''}`}
            title={split ? 'Back to one terminal' : 'Split: two terminals side by side'}
            aria-label="Split view"
            aria-pressed={split}
            onClick={() => void toggleSplit()}
            disabled={!list.length}
          >
            <Icon name="split" size={16} />
          </button>
          <button
            className="icon-btn"
            title="Find in terminal (Ctrl+F)"
            aria-label="Find in terminal"
            disabled={!list.length}
            onClick={() => {
              setFind((f) => ({ ...f, open: !f.open }))
              setTimeout(() => findBox.current?.select(), 0)
            }}
          >
            <Icon name="search" size={16} />
          </button>
          <button
            className={`btn small-btn ${showChanges ? 'on' : ''}`}
            onClick={() => setShowChanges((v) => !v)}
            title="Show the files Claude changed"
            aria-pressed={showChanges}
          >
            <Icon name="list" size={15} /> Changes
          </button>
        </div>
      </div>

      {prompts && <PromptBar ctx={ctx} projectId={projectId} hasClaude={hasClaude} onSend={(text, title) => void sendPrompt(text, title)} />}
      <LinkBanner ctx={ctx} projectId={projectId} goTab={goTab} />
      <ClaudeStatusStrip terminalId={focusedId} />

      {find.open && (
        <div className="find-bar">
          <input
            ref={findBox}
            className={`input ${find.miss ? 'miss' : ''}`}
            placeholder="Find in terminal…"
            value={find.q}
            autoFocus
            onChange={(e) => setFind({ ...find, q: e.target.value, miss: false })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') runFind(e.shiftKey)
              if (e.key === 'Escape') closeFind()
            }}
          />
          <button className="icon-btn" title="Previous (Shift+Enter)" onClick={() => runFind(true)}>
            <Icon name="arrowUp" size={15} />
          </button>
          <button className="icon-btn" title="Next (Enter)" onClick={() => runFind(false)}>
            <Icon name="arrowDown" size={15} />
          </button>
          {find.miss && <span className="muted small">No match</span>}
          <div className="grow" />
          <button className="icon-btn" title="Close (Esc)" onClick={closeFind}>
            <Icon name="close" size={13} />
          </button>
        </div>
      )}

      <div className="term-body">
        {list.length === 0 ? (
          <div className="term-empty">
            <h3>Terminal for {project.name}</h3>
            <p className="muted">
              Opens in <code>{project.localPath}</code>. Run the full Claude Code CLI, a shell, or your dev server. Terminals keep running while you
              switch projects.
            </p>
            {reopen.length > 0 && (
              <p>
                You had {reopen.length === 1 ? 'a Claude conversation' : `${reopen.length} Claude conversations`} open here: <b>{reopenNames.join(', ')}</b>
              </p>
            )}
            <div className="row gap-s">
              {reopen.length > 0 && (
                <>
                  <button className="btn primary" onClick={() => void reopenAll()}>
                    <Icon name="history" size={16} /> Reopen {reopen.length === 1 ? 'it' : 'all'}
                  </button>
                  <button className="btn ghost" title="Don't offer to reopen these again" onClick={async () => setDb(await api.forgetOpenSessions(projectId))}>
                    Don't reopen
                  </button>
                </>
              )}
              {lastConv && !reopen.length && (
                <button className="btn primary" onClick={() => void startClaude('continue')} title={continueTitle}>
                  <Icon name="history" size={16} /> Continue last conversation
                </button>
              )}
              <button
                className={`btn ${lastConv || reopen.length ? '' : 'primary'}`}
                onClick={() => void startClaude('new')}
                title="Start a new Claude Code conversation (fresh context)"
              >
                <Icon name="plus" size={16} /> New conversation
              </button>
              <button className="btn" onClick={startShell}>
                Open a shell
              </button>
            </div>
            <p className="muted small">
              <kbd>Shift+Enter</kbd> new line in Claude · <kbd>{api.platform === 'darwin' ? '⌘V' : 'Ctrl+V'}</kbd> pastes text or a screenshot · drop
              files to insert their path · <kbd>{api.platform === 'darwin' ? '⌘F' : 'Ctrl+F'}</kbd> find · click a file path to open it
            </p>
          </div>
        ) : (
          <div className={`term-panes ${split ? 'split' : ''}`}>
            {paneView('left', activeId)}
            {split && paneView('right', right)}
          </div>
        )}
        {showChanges && (
          <Suspense fallback={null}>
            <ChangesPanel
              projectId={projectId}
              theme={ctx.theme}
              base={changesBase}
              setBase={setChangesBase}
              onClose={() => setShowChanges(false)}
              goFiles={() => goTab('files')}
            />
          </Suspense>
        )}
      </div>

      {toast && (
        <div className={`term-toast ${toast.tone}`} onClick={() => setToast(null)}>
          {toast.text}
        </div>
      )}

      <GitBar
        projectId={projectId}
        commitOpen={commitOpen}
        setCommitOpen={setCommitOpen}
        onShowChanges={() => {
          setChangesBase('HEAD')
          setShowChanges(true)
        }}
        goGit={() => goTab('git')}
        onClean={() => dismissProjectTurns(projectId)}
        onUndo={undoTo}
        meters={<ClaudeMeters terminalId={focusedId} />}
        turn={
          showTurn &&
          turn && (
            <span className="turn-chip">
              <Icon name="sparkle" size={14} />
              <button
                className="link"
                title={`Review what Claude changed: ${turn.changes.map((c) => c.path).join(', ')}`}
                onClick={() => {
                  setChangesBase(turn.checkpoint)
                  setShowChanges(true)
                }}
              >
                Claude changed {turn.changes.length} file{turn.changes.length === 1 ? '' : 's'}
              </button>
              <button className="icon-btn" title="Dismiss" aria-label="Dismiss" onClick={() => focusedId && dismissTurn(focusedId)}>
                <Icon name="close" size={12} />
              </button>
            </span>
          )
        }
      />
    </div>
  )
}
