import { useEffect, useState } from 'react'
import type { Checkpoint, TreeSnapshot } from '../../shared/types'
import { ChevronDown, ChevronRight, Refresh } from './Icons'
import { ok } from '../lib/notices'
import { diffLines, withContext, type DiffLine } from '../../shared/diff'
import { api } from '../lib/api'

/**
 * Edits auto-apply, so this pane is the safety net rather than a review gate.
 * Every write is listed newest first with a diff, per-edit undo, and a way to
 * unwind a whole run.
 */

type Line = DiffLine

function Diff({ checkpointId }: { checkpointId: string }): React.JSX.Element {
  const [lines, setLines] = useState<Line[] | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    void (async () => {
      const r = await api.checkpoints.diff(checkpointId)
      if (!r.ok || !r.data) {
        setFailed(true)
        return
      }
      setLines(withContext(diffLines(r.data.before ?? '', r.data.after ?? '')))
    })()
  }, [checkpointId])

  if (failed) return <p className="changes__loading">The diff could not be read.</p>
  if (!lines) return <p className="changes__loading">Loading the diff…</p>
  return (
    <pre className="diff">
      {lines.map((l, i) => (
        <div className="diff__line" data-kind={l.kind} key={i}>
          <span className="diff__gutter">{l.kind === ' ' ? '' : l.kind}</span>
          {l.text}
        </div>
      ))}
    </pre>
  )
}

interface Props {
  conversationId: string | null
  /** Bumped by the app whenever a run writes, to force a reload. */
  tick: number
  /** A revert appends a note to the thread, so the transcript needs reloading. */
  onReverted: () => void
}

/*
  The whole tree either side of a turn, from the shadow repository. The
  checkpoints above see only what the tools wrote; this sees what a command
  did too, and puts the whole folder back.
*/
interface TurnSnapshots {
  runId: string
  before: TreeSnapshot | null
  after: TreeSnapshot | null
  restore: TreeSnapshot | null
  at: number
}

function groupSnapshots(list: TreeSnapshot[]): TurnSnapshots[] {
  const byRun = new Map<string, TurnSnapshots>()
  for (const s of list) {
    const g = byRun.get(s.runId) ?? { runId: s.runId, before: null, after: null, restore: null, at: s.createdAt }
    g[s.kind] = s
    g.at = Math.max(g.at, s.createdAt)
    byRun.set(s.runId, g)
  }
  return [...byRun.values()].sort((a, b) => b.at - a.at)
}

function TreeChanges({ conversationId, busy, setBusy, tick, onReverted }: { conversationId: string; busy: boolean; setBusy: (b: boolean) => void; tick: number; onReverted: () => void }): React.JSX.Element | null {
  const [turns, setTurns] = useState<TurnSnapshots[] | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [files, setFiles] = useState<Record<string, { status: string; path: string }[]>>({})

  useEffect(() => {
    void (async () => {
      const r = await api.snapshots.list(conversationId)
      if (r.ok && r.data) setTurns(groupSnapshots(r.data))
    })()
  }, [conversationId, tick])

  const show = async (t: TurnSnapshots): Promise<void> => {
    setOpen((id) => (id === t.runId ? null : t.runId))
    if (files[t.runId] || !t.before || !t.after) return
    const r = await api.snapshots.changes(conversationId, t.before.id, t.after.id)
    if (r.ok && r.data) setFiles((f) => ({ ...f, [t.runId]: r.data ?? [] }))
  }

  const restore = async (s: TreeSnapshot): Promise<void> => {
    setBusy(true)
    ok(await api.snapshots.restore(conversationId, s.id), 'The tree could not be restored.')
    onReverted()
    setBusy(false)
  }

  if (!turns?.length) return null
  return (
    <section className="changes__run">
      <div className="changes__runhead">
        <span className="sounding">Whole tree, by turn</span>
      </div>
      {turns.map((t) => (
        <div className="changes__item" key={t.runId}>
          <button className="changes__file" onClick={() => void show(t)}>
            <span className="tools__chevron">{open === t.runId ? <ChevronDown size={12} /> : <ChevronRight size={12} />}</span>
            <span className="changes__path">
              {t.restore ? 'Before a restore' : 'Turn'} at {new Date(t.at).toLocaleTimeString()}
              {t.before && !t.after && !t.restore ? ' (still running)' : ''}
            </span>
          </button>
          {open === t.runId && (
            <div className="changes__tree">
              {t.before && t.after && (
                <ul className="changes__treefiles">
                  {(files[t.runId] ?? []).map((f) => (
                    <li key={f.path}>
                      <span className="row__badge">{f.status}</span> {f.path}
                    </li>
                  ))}
                  {files[t.runId] && files[t.runId].length === 0 && <li className="changes__loading">No file changed in this turn.</li>}
                </ul>
              )}
              <div className="changes__treeactions">
                {t.before && (
                  <button className="btn" disabled={busy} onClick={() => void restore(t.before!)} title="Every file in the project put back as it was before this turn began.">
                    Restore tree to before
                  </button>
                )}
                {t.after && (
                  <button className="btn" disabled={busy} onClick={() => void restore(t.after!)} title="Every file put back as it was when this turn ended.">
                    Restore tree to after
                  </button>
                )}
                {t.restore && (
                  <button className="btn" disabled={busy} onClick={() => void restore(t.restore!)}>
                    Restore tree to this
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      ))}
    </section>
  )
}

export function Changes({ conversationId, tick, onReverted }: Props): React.JSX.Element {
  const [items, setItems] = useState<Checkpoint[] | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = async (): Promise<void> => {
    if (!conversationId) {
      setItems([])
      return
    }
    const r = await api.checkpoints.list(conversationId)
    // Otherwise a failure to load reads as "no changes", which is a lie.
    if (ok(r, 'The list of changes could not be loaded.') && r.data) setItems(r.data)
  }

  useEffect(() => {
    void load()
  }, [conversationId, tick])

  const undo = async (id: string): Promise<void> => {
    if (!conversationId) return
    setBusy(true)
    ok(await api.checkpoints.undo(conversationId, id), 'That edit could not be undone.')
    await load()
    onReverted()
    setBusy(false)
  }

  const revertRun = async (runId: string): Promise<void> => {
    if (!conversationId) return
    setBusy(true)
    ok(await api.checkpoints.revertRun(conversationId, runId), 'That run could not be reverted.')
    await load()
    onReverted()
    setBusy(false)
  }

  const tree = conversationId ? <TreeChanges conversationId={conversationId} busy={busy} setBusy={setBusy} tick={tick} onReverted={onReverted} /> : null

  if (items === null) return <div className="changes">{tree}</div>
  if (items.length === 0) {
    return (
      <div className="changes">
        {tree}
        <p className="changes__empty">
          No changes to show. Files the agent writes appear here, with a way back.
        </p>
      </div>
    )
  }

  // Group by run so a whole turn can be unwound in one go.
  const runs = [...new Set(items.map((c) => c.runId))]

  return (
    <div className="changes">
      {tree}
      {runs.map((runId) => {
        const inRun = items.filter((c) => c.runId === runId)
        const live = inRun.filter((c) => !c.undone).length
        return (
          <section className="changes__run" key={runId}>
            <div className="changes__runhead">
              <span className="sounding">
                {inRun.length} {inRun.length === 1 ? 'file' : 'files'}
              </span>
              {inRun.some((c) => c.webUsed) && (
                <span
                  className="row__badge row__badge--warn"
                  title="This run read web pages, which are outside your control. Worth reading these diffs closely."
                >
                  read the web
                </span>
              )}
              {/* Reverting is recovery, not destruction, so it is not red. */}
              {live > 0 && (
                <button className="btn" disabled={busy} onClick={() => void revertRun(runId)}>
                  <span className="row-of row-of--inline">
                    <Refresh size={12} />
                    Revert run
                  </span>
                </button>
              )}
            </div>

            {inRun.map((cp) => (
              <div className="changes__item" key={cp.id} data-undone={cp.undone}>
                <button
                  className="changes__file"
                  onClick={() => setOpenId((id) => (id === cp.id ? null : cp.id))}
                >
                  <span className="tools__chevron">
                    {openId === cp.id ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                  </span>
                  <span className="changes__path">{cp.path}</span>
                  {cp.created && <span className="row__badge">new</span>}
                  {cp.undone && <span className="row__badge">undone</span>}
                </button>

                {!cp.undone && (
                  <button className="changes__undo" disabled={busy} onClick={() => void undo(cp.id)}>
                    Undo
                  </button>
                )}

                {openId === cp.id && <Diff checkpointId={cp.id} />}
              </div>
            ))}
          </section>
        )
      })}
    </div>
  )
}
