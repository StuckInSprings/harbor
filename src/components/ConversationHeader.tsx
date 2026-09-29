import type { RefObject } from 'react'
import type { Conversation, Project } from '../../shared/types'
import { ROLE_LABEL, type ConversationRole } from '../../shared/director'
import type { RunStatus } from '../hooks/useDirector'
import type { InspectorMode } from './Inspector'
import { formatCost } from '../lib/format'
import { GOAL_LABEL, type GoalState } from '../../shared/goal'
import { Diff, Folder, PanelLeft, Terminal, PopOut } from './Icons'
import { api } from '../lib/api'
import { formatMoney } from '../lib/format'

const ROLE_TITLE: Record<Exclude<ConversationRole, 'chat'>, string> = {
  interview: 'An interview: the requirements for a director run are gathered here and written to _director/requirements.md. Writes go nowhere else.',
  director: 'A director: plans from the requirements, dispatches tasks to workers, judges what comes back.',
  worker: 'A worker: one task from a director, in its own conversation.'
}

interface Props {
  active: Conversation | null
  project: Project | null
  /** A window opened on one conversation shows that and nothing else. */
  popped: boolean
  sidebarOpen: boolean
  onShowSidebar: () => void
  titleRef: RefObject<HTMLInputElement | null>
  onTitleChange: (title: string) => void
  onTitleBlur: () => void
  conversationCost: number
  onStartDirector: () => void
  runView: boolean
  onToggleRunView: () => void
  runStatus: RunStatus | null
  /** Items on the board blocked on the person, and workers waiting on an answer. */
  waitingOnYou: number
  onShowWaiting: () => void
  budgetEdit: string | null
  setBudgetEdit: (text: string | null) => void
  commitBudget: () => void
  /** The director is mid-turn or has workers out: the run cannot be finished now. */
  busy: boolean
  onFinishRun: () => void
  onApprovePlan: () => void
  onKeepScratch: () => void
  onDiscardScratch: () => void
  inspector: InspectorMode
  toggleInspector: (mode: Exclude<InspectorMode, 'none'>) => void
  unreviewed: boolean
  onOpenChanges: () => void
  /** A goal the conversation works toward on its own, and where it stands. */
  goal: { text: string; state: GoalState; turns: number } | null
  onClearGoal: () => void
}

/** The line above the transcript: the title, what the conversation is, what it has cost, and the pane toggles. */
export function ConversationHeader({
  active,
  project,
  popped,
  sidebarOpen,
  onShowSidebar,
  titleRef,
  onTitleChange,
  onTitleBlur,
  conversationCost,
  onStartDirector,
  runView,
  onToggleRunView,
  runStatus,
  waitingOnYou,
  onShowWaiting,
  budgetEdit,
  setBudgetEdit,
  commitBudget,
  busy,
  onFinishRun,
  onApprovePlan,
  onKeepScratch,
  onDiscardScratch,
  inspector,
  toggleInspector,
  unreviewed,
  onOpenChanges,
  goal,
  onClearGoal
}: Props): React.JSX.Element {
  return (
    <div className="conv__head">
      {!sidebarOpen && !popped && (
        <button className="icon-btn" onClick={onShowSidebar} title="Show sidebar" aria-label="Show sidebar">
          <PanelLeft />
        </button>
      )}
      {active && !popped && (
        <button className="icon-btn" onClick={() => void api.popOut(active.id)} title="Pop this conversation out into a small window that stays on top" aria-label="Pop this conversation out into a small window that stays on top">
          <PopOut />
        </button>
      )}

      {active ? (
        <input ref={titleRef} className="conv__title" value={active.title} onChange={(e) => onTitleChange(e.target.value)} onBlur={onTitleBlur} />
      ) : (
        <span style={{ flex: 1 }} />
      )}

      {active && conversationCost > 0 && <span className="sounding">{formatCost(conversationCost)}</span>}
      {active && active.role !== 'chat' && (
        <span className="rolepill" data-role={active.role} title={ROLE_TITLE[active.role]}>
          {ROLE_LABEL[active.role]}
        </span>
      )}
      {active?.role === 'interview' && project && (
        <button className="btn btn--small" onClick={onStartDirector} title="Hand the requirements to a director, once they are written">
          Start the director…
        </button>
      )}
      {active?.role === 'director' && (
        <button className="btn btn--small" aria-pressed={runView} onClick={onToggleRunView} title={runView ? 'Show the conversation' : 'Show the run'} aria-label={runView ? 'Show the conversation' : 'Show the run'}>
          {runView ? 'Chat' : 'Run'}
        </button>
      )}
      {active?.role === 'director' && runStatus && (
        <span className="run">
          {budgetEdit !== null ? (
            <input
              className="input input--mono run__budget"
              autoFocus
              value={budgetEdit}
              inputMode="decimal"
              onChange={(e) => setBudgetEdit(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitBudget()
                if (e.key === 'Escape') {
                  e.stopPropagation()
                  setBudgetEdit(null)
                }
              }}
              onBlur={commitBudget}
            />
          ) : (
            <button
              className="sounding run__spend"
              data-spent={runStatus.budget > 0 && runStatus.spent >= runStatus.budget}
              onClick={() => setBudgetEdit(String(runStatus.budget))}
              title="Spent against the run's budget. Click to raise or lower the budget; a run that spent its budget continues once it is raised."
            >
              {formatMoney(runStatus.spent)}
              {runStatus.budget > 0 ? ` of ${formatMoney(runStatus.budget)}` : ' spent, no ceiling'}
            </button>
          )}
          {(runStatus.branch || runStatus.base) && (
            <span className="conv__pill" title={runStatus.branch ? `The run works on its own branch, from ${runStatus.base ?? '?'}` : `The run started from commit ${runStatus.base}; review with git diff ${runStatus.base}`}>
              {runStatus.branch ?? `from ${runStatus.base}`}
            </span>
          )}
          {waitingOnYou > 0 && (
            <button className="btn btn--small run__waiting" onClick={onShowWaiting} title="Show what the run is waiting on you for">
              {waitingOnYou} waiting on you
            </button>
          )}
          {runStatus.approved ? (
            <>
              <span className="run__state" data-on="true">
                Approved
              </span>
              <button className="btn btn--small" disabled={busy} onClick={onFinishRun} title="Write the run log to _director/runs/ and archive the worker conversations. Only when nothing is running.">
                Finish run
              </button>
            </>
          ) : (
            <>
              <span className="run__state">Awaiting approval</span>
              <button className="btn btn--small btn--primary" onClick={onApprovePlan} title="Read _director/design.md and _director/tasks.md first; this lets the director begin">
                Approve plan
              </button>
            </>
          )}
        </span>
      )}
      {active?.scratch && (
        <span className="scratch">
          <span className="scratch__note" title="A quick question: gone when you leave it, unless kept.">
            Not kept
          </span>
          <button className="btn btn--small" onClick={onKeepScratch} title="Keep this conversation after all">
            Keep
          </button>
          <button className="btn btn--small" onClick={onDiscardScratch} title="Discard it now">
            Discard
          </button>
        </span>
      )}
      {active && goal && (
        <span className="conv__pill" data-goal={goal.state} title={`Goal: ${goal.text}\n${GOAL_LABEL[goal.state]}, ${goal.turns} turn${goal.turns === 1 ? '' : 's'} so far. Click × to clear it.`}>
          goal · {GOAL_LABEL[goal.state]} · {goal.turns}
          <button className="conv__pill-x" onClick={onClearGoal} title="Clear the goal">
            ×
          </button>
        </span>
      )}
      {active && project && <span className="conv__pill">{project.name}</span>}

      <div className="conv__tools">
        <button className="icon-btn" aria-pressed={inspector === 'terminal'} onClick={() => toggleInspector('terminal')} title="Terminal" aria-label="Terminal">
          <Terminal />
        </button>
        <button className="icon-btn" aria-pressed={inspector === 'changes'} data-alert={unreviewed} onClick={onOpenChanges} title={unreviewed ? 'Changes — files were written' : 'Changes'} aria-label={unreviewed ? 'Changes — files were written' : 'Changes'}>
          <Diff />
        </button>
        <button className="icon-btn" aria-pressed={inspector === 'explorer'} disabled={!project?.rootPath} onClick={() => toggleInspector('explorer')} title={project?.rootPath ? 'Explorer' : 'Explorer — set a project folder first'} aria-label={project?.rootPath ? 'Explorer' : 'Explorer — set a project folder first'}>
          <Folder />
        </button>
      </div>
    </div>
  )
}
