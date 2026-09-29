import { useEffect, useState } from 'react'
import type { FileVersion } from '../../shared/types'
import { changeCounts, diffLines, withContext, type DiffLine } from '../../shared/diff'
import { notify, ok } from '../lib/notices'
import { api } from '../lib/api'

/**
 * A file's versions, across every conversation that touched it.
 *
 * Every agent write is already checkpointed, but only by conversation. Prose
 * is worked on across many, and what a draft process needs is the file's own
 * timeline: which version says what, the difference between any two, and a
 * way back to one — or a copy of it under a new name, when both should live.
 */

interface Props {
  conversationId: string
  path: string
  /** What the file says now, for the diff against the newest version. */
  current: string | null
  onChanged: () => void
}

const when = (t: number): string => {
  const d = new Date(t)
  const today = new Date().toDateString() === d.toDateString()
  return today
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' }) +
        ' ' +
        d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export function Drafts({ conversationId, path, current, onChanged }: Props): React.JSX.Element {
  const [versions, setVersions] = useState<FileVersion[] | null>(null)
  const [texts, setTexts] = useState<Record<string, string | null>>({})
  /** The version being read, and the one it is read against. */
  const [pick, setPick] = useState<string | null>(null)
  const [against, setAgainst] = useState<'current' | 'previous'>('previous')
  const [busy, setBusy] = useState(false)
  const [naming, setNaming] = useState<string | null>(null)

  const load = async (): Promise<void> => {
    const r = await api.checkpoints.history(conversationId, path)
    if (!ok(r, 'The history could not be loaded.') || !r.data) return
    setVersions(r.data)
    if (r.data.length && !pick) setPick(r.data[0].checkpointId)
  }
  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, path])

  const textOf = async (hash: string | null): Promise<string | null> => {
    if (hash === null) return null
    if (hash in texts) return texts[hash]
    const r = await api.checkpoints.blob(hash)
    const t = r.ok ? (r.data ?? null) : null
    setTexts((m) => ({ ...m, [hash]: t }))
    return t
  }

  const list = versions ?? []
  const chosen = list.find((v) => v.checkpointId === pick) ?? null
  const chosenAt = chosen ? list.indexOf(chosen) : -1
  const previous = chosenAt !== -1 ? (list[chosenAt + 1] ?? null) : null

  const [lines, setLines] = useState<DiffLine[] | null>(null)
  useEffect(() => {
    if (!chosen) {
      setLines(null)
      return
    }
    let live = true
    void (async () => {
      const after = (await textOf(chosen.hash)) ?? ''
      const before =
        against === 'current' ? (current ?? '') : previous ? ((await textOf(previous.hash)) ?? '') : ''
      if (!live) return
      // Against "current" the arrow points the other way: what the file has that this version lacks.
      setLines(against === 'current' ? diffLines(after, before) : diffLines(before, after))
    })()
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chosen?.checkpointId, against, current, previous?.checkpointId])

  const restore = async (): Promise<void> => {
    if (!chosen?.hash) return
    setBusy(true)
    if (ok(await api.checkpoints.restore(conversationId, path, chosen.hash), 'It could not be restored.')) {
      onChanged()
      await load()
    }
    setBusy(false)
  }

  const saveAs = async (newPath: string): Promise<void> => {
    if (!chosen?.hash || !newPath.trim()) return
    setBusy(true)
    if (ok(await api.checkpoints.saveAs(conversationId, path, chosen.hash, newPath.trim()), 'It could not be saved.')) {
      notify(`Saved as ${newPath.trim()}.`, 'info')
      onChanged()
    }
    setBusy(false)
    setNaming(null)
  }

  if (versions === null) return <p className="drafts__empty">Reading the versions…</p>
  if (versions.length === 0) {
    return (
      <p className="drafts__empty">
        No saved versions yet. Every write the agent makes to this file will appear here, with
        the differences between them.
      </p>
    )
  }

  const counts = lines ? changeCounts(lines) : null

  return (
    <div className="drafts">
      <ol className="drafts__list">
        {versions.map((v, i) => (
          <li key={v.checkpointId}>
            <button
              className="drafts__row"
              aria-current={v.checkpointId === pick}
              onClick={() => setPick(v.checkpointId)}
            >
              <span className="drafts__n sounding">v{versions.length - i}</span>
              <span className="drafts__when">{when(v.createdAt)}</span>
              <span className="drafts__conv" title={v.conversationTitle}>{v.conversationTitle}</span>
              {v.created && <span className="row__badge">new</span>}
              {v.undone && <span className="row__badge">undone</span>}
              {v.hash === null && <span className="row__badge row__badge--warn">deleted</span>}
            </button>
          </li>
        ))}
      </ol>

      {chosen && (
        <div className="drafts__detail">
          <div className="drafts__bar">
            <span className="sounding">
              v{versions.length - chosenAt}
              {counts ? ` · +${counts.added} −${counts.removed}` : ''}
            </span>
            <span className="drafts__against">
              <button className="chip" aria-pressed={against === 'previous'} onClick={() => setAgainst('previous')} disabled={!previous}>
                vs previous
              </button>
              <button className="chip" aria-pressed={against === 'current'} onClick={() => setAgainst('current')}>
                vs file now
              </button>
            </span>
            <span className="composer__spacer" />
            {naming === null ? (
              <>
                <button className="btn" disabled={busy || !chosen.hash} onClick={() => setNaming(path.replace(/(\.[^./]+)?$/, '-v2$1'))}>
                  Save as copy…
                </button>
                <button className="btn btn--primary" disabled={busy || !chosen.hash} onClick={() => void restore()}>
                  Restore this version
                </button>
              </>
            ) : (
              <input
                className="input input--mono drafts__name"
                autoFocus
                value={naming}
                onChange={(e) => setNaming(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.stopPropagation()
                    setNaming(null)
                  }
                  if (e.key === 'Enter') void saveAs(naming)
                }}
                onBlur={() => setNaming(null)}
              />
            )}
          </div>
          {lines ? (
            <pre className="diff">
              {withContext(lines).map((l, i) => (
                <div className="diff__line" data-kind={l.kind} key={i}>
                  <span className="diff__gutter">{l.kind === ' ' ? '' : l.kind}</span>
                  {l.text}
                </div>
              ))}
            </pre>
          ) : (
            <p className="changes__loading">Loading…</p>
          )}
        </div>
      )}
    </div>
  )
}
