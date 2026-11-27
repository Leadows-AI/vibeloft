import { useState, type ReactNode } from 'react'
import type { ClaudeSession } from '../../../../shared/types'
import { Icon } from '../../icons'
import { Dropdown } from './Dropdown'
import { HistoryList } from './HistoryMenu'
import { StartOptions } from './StartMenu'

// The terminal toolbar's one "+" menu: every way to open a terminal (continue,
// new, resume, shell, scripts), plus the text size.

export function NewMenu(props: {
  projectId: string
  linked: { name: string; path: string }[]
  /** Name of the conversation Continue would reopen; null when there is none. */
  lastName: string | null
  /** The last conversation is already open in a tab: Continue switches to it. */
  lastOpen: boolean
  continueTitle: string
  /** Called as the menu opens, to look for the last conversation again. */
  onOpen: () => void
  reopen: string[]
  scripts: { label: string; command: string }[]
  findLast: () => Promise<ClaudeSession | null>
  onContinue: () => void
  onNew: () => void
  onReopen: () => void
  onShell: () => void
  onStart: (command: string, title: string) => void
  onResume: (s: ClaudeSession) => void
  onZoom: (step: 1 | -1) => void
}): ReactNode {
  const [view, setView] = useState<'main' | 'options' | 'history'>('main')
  const back = (
    <button className="new-menu-back" onClick={() => setView('main')}>
      <b>← Back</b>
    </button>
  )
  const item = (close: () => void, run: () => void, label: ReactNode, hint?: string, disabled?: boolean, title?: string): ReactNode => (
    <button
      role="menuitem"
      disabled={disabled}
      title={title}
      onClick={() => {
        close()
        run()
      }}
    >
      <b>{label}</b>
      {hint && <span>{hint}</span>}
    </button>
  )

  return (
    <Dropdown
      label={
        <>
          <Icon name="plus" size={15} />
          <Icon name="chevronDown" size={13} />
        </>
      }
      className="btn small-btn primary new-menu-btn"
      title="New terminal: continue or start a Claude Code conversation, open a shell or run a script"
      align="left"
      width={400}
      onOpen={() => {
        setView('main')
        props.onOpen()
      }}
    >
      {(close) => (
        <div className="new-menu">
          {view === 'options' && (
            <>
              {back}
              <StartOptions linked={props.linked} findLast={props.findLast} onStart={props.onStart} close={close} />
            </>
          )}
          {view === 'history' && (
            <>
              {back}
              <HistoryList
                projectId={props.projectId}
                onResume={(s) => {
                  close()
                  props.onResume(s)
                }}
              />
            </>
          )}
          {view === 'main' && (
            <>
              {props.reopen.length > 0 &&
                item(close, props.onReopen, `Reopen ${props.reopen.length === 1 ? 'your conversation' : `${props.reopen.length} conversations`}`, props.reopen.join(', '))}
              {props.lastOpen
                ? item(close, props.onContinue, 'Go to last conversation', 'It’s already open in a tab here')
                : item(close, props.onContinue, 'Continue last conversation', props.lastName ?? props.continueTitle, !props.lastName, props.continueTitle)}
              {item(close, props.onNew, 'New conversation', 'Fresh context')}
              <button role="menuitem" onClick={() => setView('options')}>
                <b>New conversation with options…</b>
                <span>Mode, model and linked projects</span>
              </button>
              <button role="menuitem" onClick={() => setView('history')}>
                <b>Resume a conversation…</b>
                <span>Pick one from this project's history</span>
              </button>
              <hr />
              {item(close, props.onShell, 'Shell', 'A plain terminal in this project')}
              {props.scripts.length > 0 && <div className="menu-label">Run script</div>}
              {props.scripts.map((s) => item(close, () => props.onStart(s.command, s.label), s.label))}
              <hr />
              <div className="new-menu-zoom">
                <span className="muted small">Text size</span>
                <button className="btn small-btn" title="Smaller text (Ctrl −)" aria-label="Smaller text" onClick={() => props.onZoom(-1)}>
                  <Icon name="textSmaller" size={15} />
                </button>
                <button className="btn small-btn" title="Bigger text (Ctrl +)" aria-label="Bigger text" onClick={() => props.onZoom(1)}>
                  <Icon name="textBigger" size={15} />
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </Dropdown>
  )
}
