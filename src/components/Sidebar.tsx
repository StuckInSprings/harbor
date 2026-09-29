import { useEffect, useMemo, useState } from 'react'
import type { Conversation, Project } from '../../shared/types'
import {
  Anchor,
  Bookmark,
  ChevronDown,
  ChevronRight,
  Compass,
  Cross,
  Dot,
  Layers,
  PanelLeft,
  Plus,
  Search,
  Sliders,
  Spark,
  Terminal,
  Trash,
  Warning
} from './Icons'
import { GENERAL_PROJECT_ID } from '../../shared/types'
import { formatCost } from '../lib/format'
import { RECENT, groupByRecency, matchesFilter, moveItem, shownRows } from '../../shared/sidebar'

interface Props {
  projects: Project[]
  conversations: Conversation[]
  activeId: string | null
  spendByProject: Record<string, number>
  /** Which conversations are mid-run or waiting on you. */
  status: Record<string, 'running' | 'blocked' | 'failed'>
  onSelect: (id: string) => void
  onNew: (projectId: string) => void
  /** A throwaway conversation in the project: answered, then gone. */
  onAsk: (projectId: string) => void
  /** An interview that writes the requirements for a director run in the project. */
  onInterview: (projectId: string) => void
  onNewProject: () => void
  onOpenContext: () => void
  onOpenSearch: () => void
  onConversationMenu: (c: Conversation) => void
  /** Several conversations at once, chosen with ⌘-click and shift-click. */
  onDeleteMany: (ids: string[]) => Promise<void>
  onArchiveMany: (ids: string[]) => Promise<void>
  /** The right-click menu for a selection; resolves true when the selection should be let go. */
  onSelectionMenu: (ids: string[]) => Promise<boolean>
  onProjectMenu: (projectId: string) => void
  /** The projects in a new order, by id, after one was dragged. */
  onReorderProjects: (ids: string[]) => void
  /** Projects currently showing their archived conversations. */
  showArchived: Record<string, boolean>
  onEditProject: (projectId: string) => void
  onOpenUsage: () => void
  onOpenSettings: () => void
  onOpenLog: () => void
  onToggle: () => void
}

/**
 * The sidebar: what you can do, then where you are, then where else you
 * can go. Three actions sit in a row at the top; the projects follow, each
 * showing what is pinned and what is recent and the rest on request; the
 * places that open a sheet sit in a row at the foot, out of the list they
 * used to lengthen.
 */
export function Sidebar({
  projects,
  conversations,
  activeId,
  spendByProject,
  status,
  onSelect,
  onNew,
  onAsk,
  onInterview,
  onNewProject,
  onOpenContext,
  onOpenSearch,
  onConversationMenu,
  onDeleteMany,
  onArchiveMany,
  onSelectionMenu,
  onProjectMenu,
  onReorderProjects,
  showArchived,
  onEditProject,
  onOpenUsage,
  onOpenSettings,
  onOpenLog,
  onToggle
}: Props): React.JSX.Element {
  const activeConv = conversations.find((c) => c.id === activeId) ?? null
  /*
    Folded projects, and projects opened out to their whole history. Both
    are this browser's memory only; the project you land in unfolds by
    itself.
  */
  const [folded, setFolded] = useState<Record<string, boolean>>(() => readFlags(FOLDS_KEY))
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() => readFlags(EXPANDED_KEY))
  const [filters, setFilters] = useState<Record<string, string>>({})
  useEffect(() => writeFlags(FOLDS_KEY, folded), [folded])
  useEffect(() => writeFlags(EXPANDED_KEY, expanded), [expanded])
  useEffect(() => {
    const pid = activeConv?.projectId
    if (pid && folded[pid]) setFolded((f) => ({ ...f, [pid]: false }))
  }, [activeConv?.projectId]) // eslint-disable-line react-hooks/exhaustive-deps
  const activeProjectId = activeConv?.projectId ?? projects[0]?.id ?? null
  const activeProject = projects.find((p) => p.id === activeProjectId) ?? null

  /*
    Selecting several. ⌘-click adds a row, shift-click takes the run between
    the last click and this one within the same project, Escape lets go. While
    anything is selected a bar at the foot of the sidebar offers what can be
    done to all of them at once; a plain click anywhere lets go and opens.
  */
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [anchor, setAnchor] = useState<string | null>(null)
  const clearSelection = (): void => {
    setSelected(new Set())
    setAnchor(null)
  }
  useEffect(() => {
    if (selected.size === 0) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') clearSelection()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selected.size])
  // Rows that vanish — deleted, archived — leave the selection too.
  useEffect(() => {
    setSelected((s) => {
      const alive = new Set(conversations.map((c) => c.id))
      const next = new Set([...s].filter((id) => alive.has(id)))
      return next.size === s.size ? s : next
    })
  }, [conversations])
  const clickRow = (e: React.MouseEvent, c: Conversation, visible: Conversation[]): void => {
    if (e.shiftKey && anchor) {
      const ids = visible.map((v) => v.id)
      const a = ids.indexOf(anchor)
      const b = ids.indexOf(c.id)
      if (a !== -1 && b !== -1) {
        const [lo, hi] = a < b ? [a, b] : [b, a]
        setSelected((s) => new Set([...s, ...ids.slice(lo, hi + 1)]))
        return
      }
    }
    if (e.metaKey || e.ctrlKey) {
      setSelected((s) => {
        const next = new Set(s)
        if (next.has(c.id)) next.delete(c.id)
        else next.add(c.id)
        return next
      })
      setAnchor(c.id)
      return
    }
    if (selected.size > 0) clearSelection()
    setAnchor(c.id)
    onSelect(c.id)
  }

  /*
    Projects are put in order by dragging a project's head onto another's:
    the upper half of the target drops before it, the lower half after,
    and a line shows which. The right-click menu's Move up and Move down
    do the same from the keyboard.
  */
  const [dragging, setDragging] = useState<string | null>(null)
  const [dropAt, setDropAt] = useState<{ id: string; place: 'before' | 'after' } | null>(null)
  const endDrag = (): void => {
    setDragging(null)
    setDropAt(null)
  }

  const byProject = useMemo(() => {
    const map = new Map<string, Conversation[]>()
    for (const c of conversations) {
      if (c.scratch) continue
      map.set(c.projectId, [...(map.get(c.projectId) ?? []), c])
    }
    return map
  }, [conversations])

  const rowFor = (c: Conversation, visible: Conversation[]): React.JSX.Element => {
    /*
      Commands are approval-gated, so a run in a conversation you are not
      looking at can sit blocked indefinitely. This is where you find out.
    */
    const state = status[c.id]
    return (
      <button
        key={c.id}
        className="row"
        aria-current={c.id === activeId}
        data-selected={selected.has(c.id)}
        data-archived={c.archived}
        data-role={c.role}
        onClick={(e) => clickRow(e, c, visible)}
        onContextMenu={() => {
          // A right-click on one of the selected rows is about all of them.
          if (selected.size > 0 && selected.has(c.id)) {
            void onSelectionMenu([...selected]).then((done) => {
              if (done) clearSelection()
            })
          } else onConversationMenu(c)
        }}
      >
        <span
          className={`row__icon${state ? ` status--${state}` : ''}`}
          title={state === 'failed' ? 'The last reply here failed; open it to see why' : state === 'blocked' ? 'Waiting for you to approve a command' : state === 'running' ? 'A reply is being written' : undefined}
        >
          {selected.size > 0 ? (
            <span className="row__tick" data-on={selected.has(c.id)} />
          ) : state === 'blocked' ? (
            <Warning size={13} />
          ) : state === 'running' ? (
            <span className="row__spinner" />
          ) : state === 'failed' ? (
            <Cross size={13} />
          ) : c.id === activeId ? (
            <Anchor size={13} />
          ) : (
            <Dot size={13} />
          )}
        </span>
        <span className="row__label">{c.title}</span>
        {c.pinned && <span className="row__pin" aria-label="pinned" />}
      </button>
    )
  }

  const live = projects.filter((p) => !p.archived)
  const archived = projects.filter((p) => p.archived)
  const [archiveOpen, setArchiveOpen] = useState<boolean>(() => readFlags(ARCHIVE_KEY).open === true)
  useEffect(() => writeFlags(ARCHIVE_KEY, { open: archiveOpen }), [archiveOpen])
  // A conversation opened in an archived project opens the section it is in.
  useEffect(() => {
    if (activeConv && projects.find((p) => p.id === activeConv.projectId)?.archived) setArchiveOpen(true)
  }, [activeConv?.projectId]) // eslint-disable-line react-hooks/exhaustive-deps

  const renderZone = (project: Project): React.JSX.Element => {
          const all = byProject.get(project.id) ?? []
          const own = showArchived[project.id] ? all : all.filter((c) => !c.archived)
          const hidden = all.length - own.length
          const spend = spendByProject[project.id] ?? 0
          const isFolded = !!folded[project.id]
          const isExpanded = !!expanded[project.id]
          const busy = own.filter((c) => status[c.id]).length
          const filter = filters[project.id] ?? ''
          const filtered = isExpanded && filter.trim() ? own.filter((c) => matchesFilter(c.title, filter)) : own
          const { rows, more } = shownRows(filtered, isExpanded)
          // A long history is read in buckets, and searched; a short one is just a list.
          const long = own.length > RECENT * 2
          const groups = isExpanded && long ? groupByRecency(rows) : null
          return (
            <div
              className="zone"
              key={project.id}
              data-folded={isFolded}
              data-general={project.id === GENERAL_PROJECT_ID ? 'true' : undefined}
              data-dragging={dragging === project.id || undefined}
              data-drop={dropAt?.id === project.id ? dropAt.place : undefined}
              onDragOver={(e) => {
                if (!dragging || dragging === project.id) return
                e.preventDefault()
                e.dataTransfer.dropEffect = 'move'
                const box = e.currentTarget.getBoundingClientRect()
                const place = e.clientY < box.top + Math.min(box.height, 60) / 2 ? 'before' : 'after'
                if (dropAt?.id !== project.id || dropAt.place !== place) setDropAt({ id: project.id, place })
              }}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node | null) && dropAt?.id === project.id) setDropAt(null)
              }}
              onDrop={(e) => {
                e.preventDefault()
                if (dragging && dropAt) onReorderProjects(moveItem(projects.map((p) => p.id), dragging, dropAt.id, dropAt.place))
                endDrag()
              }}
            >
              <div
                className="zone__head"
                draggable
                title="Drag to move this project"
                onDragStart={(e) => {
                  setDragging(project.id)
                  e.dataTransfer.effectAllowed = 'move'
                  e.dataTransfer.setData('text/plain', project.name)
                }}
                onDragEnd={endDrag}
              >
                <button
                  className="zone__fold"
                  onClick={() => setFolded((f) => ({ ...f, [project.id]: !isFolded }))}
                  title={isFolded ? `Show ${own.length} conversation${own.length === 1 ? '' : 's'}` : 'Fold this project away'}
                  aria-expanded={!isFolded}
                  aria-label={isFolded ? `Show ${project.name}` : `Fold ${project.name} away`}
                >
                  {isFolded ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
                </button>
                <button
                  className="zone__title"
                  onClick={() => onEditProject(project.id)}
                  onContextMenu={() => onProjectMenu(project.id)}
                  title={project.id === GENERAL_PROJECT_ID ? 'Chats that belong to no project. Click for their default model and instructions.' : 'Project settings'}
                >
                  {project.name}
                </button>
                <span className="zone__actions">
                  {isFolded && own.length > 0 && (
                    <span className="sounding" title={busy ? `${busy} running or waiting on you` : undefined}>
                      {own.length}
                      {busy > 0 && <span className="zone__busy" />}
                    </span>
                  )}
                  {spend > 0 && <span className="sounding">{formatCost(spend)}</span>}
                  <button className="icon-btn" onClick={() => onNew(project.id)} title={`New conversation in ${project.name}`} aria-label={`New conversation in ${project.name}`}>
                    <Plus size={14} />
                  </button>
                </span>
              </div>

              {!isFolded && own.length === 0 && <p className="zone__empty">{project.id === GENERAL_PROJECT_ID ? 'Chats that belong to no project land here.' : 'Nothing here yet.'}</p>}

              {!isFolded && isExpanded && long && (
                <input
                  className="zone__filter"
                  placeholder={`Filter ${own.length} conversations`}
                  aria-label={`Filter the conversations in ${project.name}`}
                  value={filter}
                  onChange={(e) => setFilters((f) => ({ ...f, [project.id]: e.target.value }))}
                />
              )}

              {!isFolded && groups
                ? groups.map((g) => (
                    <div className="zone__group" key={g.label}>
                      <div className="zone__label">{g.label}</div>
                      {g.rows.map((c) => rowFor(c, rows))}
                    </div>
                  ))
                : !isFolded && rows.map((c) => rowFor(c, rows))}

              {!isFolded && isExpanded && long && filter.trim() && rows.length === 0 && <p className="zone__empty">Nothing matches.</p>}

              {!isFolded && (more > 0 || isExpanded) && own.length > RECENT && (
                <button
                  className="zone__more"
                  onClick={() => {
                    setExpanded((x) => ({ ...x, [project.id]: !isExpanded }))
                    if (isExpanded) setFilters((f) => ({ ...f, [project.id]: '' }))
                  }}
                >
                  {isExpanded ? 'Show recent only' : `Show all ${own.length}`}
                </button>
              )}

              {!isFolded && hidden > 0 && (
                <button className="zone__more" onClick={() => onProjectMenu(project.id)}>
                  {hidden} archived
                </button>
              )}
            </div>
          )
        }

  return (
    <nav className="sidebar" aria-label="Conversations">
      <div className="sidebar__chrome">
        <button className="icon-btn" onClick={onToggle} title="Hide sidebar" aria-label="Hide sidebar">
          <PanelLeft />
        </button>
      </div>

      {/* What you can do, in a row: a conversation, a question, a run; and the search. */}
      <div className="sidebar__actions">
        <button
          className="btn btn--primary sidebar__action"
          onClick={() => onNew(activeProjectId ?? GENERAL_PROJECT_ID)}
          title={`New conversation in ${activeProject?.name ?? 'Chats'} (⌘N)`}
        >
          <Plus size={14} />
          New
        </button>
        <button
          className="btn sidebar__action"
          onClick={() => onAsk(GENERAL_PROJECT_ID)}
          title="Ask something and move on: the conversation is not kept (⌘⇧N)"
        >
          <Spark size={14} />
          Ask
        </button>
        <button
          className="btn sidebar__action"
          onClick={() => onInterview(activeProjectId ?? '')}
          title="Plan a bigger piece of work: an interview gathers the requirements, then a director plans and runs it"
        >
          <Compass size={14} />
          Plan
        </button>
        <button className="icon-btn" onClick={onOpenSearch} title="Search everything (⌘K)" aria-label="Search everything (⌘K)">
          <Search size={15} />
        </button>
      </div>

      <div className="sidebar__scroll">
        {live.map((project) => renderZone(project))}

        <div className="zone">
          <button className="row" onClick={onNewProject}>
            <span className="row__icon">
              <Plus />
            </span>
            <span className="row__label">New project</span>
          </button>
        </div>

        {/* Projects put away: out of the list above and the plan picker, one click from coming back. */}
        {archived.length > 0 && (
          <div className="zone zone--archive">
            <button className="zone__more" aria-expanded={archiveOpen} onClick={() => setArchiveOpen((v) => !v)}>
              {archiveOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />} Archived projects · {archived.length}
            </button>
            {archiveOpen && archived.map((project) => renderZone(project))}
          </div>
        )}
      </div>

      {selected.size > 0 && (
        <div className="selbar">
          <span className="selbar__count">{selected.size} selected</span>
          <button
            className="icon-btn"
            title="Archive the selected conversations"
            aria-label="Archive the selected conversations"
            onClick={() => {
              const ids = [...selected]
              clearSelection()
              void onArchiveMany(ids)
            }}
          >
            <Bookmark size={14} />
          </button>
          <button
            className="icon-btn icon-btn--danger"
            title="Delete the selected conversations…"
            aria-label="Delete the selected conversations…"
            onClick={() => {
              const ids = [...selected]
              void onDeleteMany(ids).then(clearSelection)
            }}
          >
            <Trash size={14} />
          </button>
          <button className="icon-btn" title="Let go (Escape)" aria-label="Let go (Escape)" onClick={clearSelection}>
            <Cross size={14} />
          </button>
        </div>
      )}

      {/* Where else to go: the sheets, out of the list. */}
      <div className="sidebar__foot">
        <button className="sidebar__place" onClick={onOpenContext} title="Skills, knowledge and memory for the project you are in">
          <Layers size={14} />
          <span>Context</span>
        </button>
        <button className="sidebar__place" onClick={onOpenUsage} title="What has been spent, by project and by day">
          <Bookmark size={14} />
          <span>Usage</span>
        </button>
        <button className="sidebar__place" onClick={onOpenSettings} title="Settings (⌘,)">
          <Sliders size={14} />
          <span>Settings</span>
        </button>
        <button className="sidebar__place" onClick={onOpenLog} title="What the app is actually doing">
          <Terminal size={14} />
          <span>Log</span>
        </button>
      </div>
    </nav>
  )
}

const FOLDS_KEY = 'harbor.sidebar.folded'
const EXPANDED_KEY = 'harbor.sidebar.expanded'
const ARCHIVE_KEY = 'harbor.sidebar.archive'
function readFlags(key: string): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(key)
    const parsed: unknown = raw ? JSON.parse(raw) : null
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, boolean>) : {}
  } catch {
    return {}
  }
}
function writeFlags(key: string, f: Record<string, boolean>): void {
  try {
    localStorage.setItem(key, JSON.stringify(f))
  } catch {
    // Nothing to do; the flag just does not survive a restart.
  }
}
