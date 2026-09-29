import { useCallback, useEffect, useRef, useState } from 'react'
import type { WorkspaceEntry } from '../../shared/types'
import { formatBytes, isAttachable, isImage, joinPath } from '../../shared/files'
import { ChevronDown, ChevronRight, Plus, Refresh } from './Icons'
import { notify } from '../lib/notices'
import { api } from '../lib/api'

/**
 * The project folder as a tree.
 *
 * Directories open on demand, so a large project costs one listing per
 * folder looked into rather than a walk of the whole thing. What the agent
 * cannot open — version control, dependencies, secrets — is not listed,
 * so the tree and the jail agree.
 */

/*
  What the tree looked like, kept across the pane being replaced by a file
  view or closed altogether. Opening a file and coming back should find the
  same folders open and the list where it was; a tree that folded itself
  every time would be a tree you stop using. Keyed by the project folder,
  so every conversation in a project shares one.
*/
interface Remembered {
  open: Set<string>
  listings: Record<string, WorkspaceEntry[]>
  scrollTop: number
}
const remembered = new Map<string, Remembered>()

interface Props {
  conversationId: string | null
  /** The project folder, as the key the tree is remembered under. */
  rootPath: string
  rootName: string
  /** Bumped when the agent writes, so the tree picks up new files. */
  reloadToken: number
  selected: string | null
  onOpen: (path: string) => void
  onAttach: (path: string) => void
}

export function Explorer({
  conversationId,
  rootPath,
  rootName,
  reloadToken,
  selected,
  onOpen,
  onAttach
}: Props): React.JSX.Element {
  const saved = remembered.get(rootPath)
  const [listings, setListings] = useState<Record<string, WorkspaceEntry[]>>(saved?.listings ?? {})
  const [open, setOpen] = useState<Set<string>>(saved?.open ?? new Set(['.']))
  const body = useRef<HTMLDivElement>(null)

  // Remember as we go, and the scroll position on the way out.
  useEffect(() => {
    remembered.set(rootPath, { open, listings, scrollTop: saved?.scrollTop ?? 0 })
  }, [rootPath, open, listings, saved?.scrollTop])
  useEffect(() => {
    const el = body.current
    if (el && saved) el.scrollTop = saved.scrollTop
    return () => {
      const cur = remembered.get(rootPath)
      if (cur && el) remembered.set(rootPath, { ...cur, scrollTop: el.scrollTop })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootPath])

  const load = useCallback(
    async (dir: string) => {
      if (!conversationId) return
      const r = await api.workspace.tree(conversationId, dir)
      if (r.ok && r.data) setListings((l) => ({ ...l, [dir]: r.data as WorkspaceEntry[] }))
      else notify(r.error ?? `${dir} could not be listed.`)
    },
    [conversationId]
  )

  // The root, and anything already open, refresh together. What is remembered
  // is shown at once; the fresh listing replaces it when it arrives.
  useEffect(() => {
    if (!conversationId) return
    for (const dir of open) void load(dir)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, reloadToken, load])

  const toggle = (dir: string): void => {
    setOpen((set) => {
      const next = new Set(set)
      if (next.has(dir)) next.delete(dir)
      else {
        next.add(dir)
        if (!listings[dir]) void load(dir)
      }
      return next
    })
  }

  if (!conversationId) {
    return <p style={{ color: 'var(--ink-faint)', padding: 16 }}>Open a conversation in a project with a folder.</p>
  }

  const render = (dir: string, depth: number): React.JSX.Element[] => {
    const rows = listings[dir]
    if (!rows) return [<div className="explorer__row explorer__row--note" key={`${dir}/…`} style={{ paddingLeft: 12 + depth * 14 }}>…</div>]
    if (rows.length === 0) return [<div className="explorer__row explorer__row--note" key={`${dir}/empty`} style={{ paddingLeft: 12 + depth * 14 }}>empty</div>]
    return rows.flatMap((e) => {
      const path = joinPath(dir, e.name)
      if (e.kind === 'dir') {
        const isOpen = open.has(path)
        return [
          <button
            className="explorer__row explorer__row--dir"
            key={path}
            style={{ paddingLeft: 12 + depth * 14 }}
            onClick={() => toggle(path)}
          >
            <span className="explorer__chevron">{isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}</span>
            <span className="explorer__name">{e.name}</span>
          </button>,
          ...(isOpen ? render(path, depth + 1) : [])
        ]
      }
      return [
        <div
          className="explorer__row explorer__row--file"
          key={path}
          aria-current={path === selected}
          data-image={isImage(path)}
          style={{ paddingLeft: 12 + depth * 14 + 18 }}
        >
          <button className="explorer__open" onClick={() => onOpen(path)} title={path} aria-label={path}>
            <span className="explorer__name">{e.name}</span>
          </button>
          <span className="sounding">{formatBytes(e.size)}</span>
          {isAttachable(path) && (
            <button
              className="explorer__attach"
              title="Attach to the next message"
              onClick={() => onAttach(path)}
             aria-label="Attach to the next message">
              <Plus size={12} />
            </button>
          )}
        </div>
      ]
    })
  }

  return (
    <div className="explorer">
      <div className="explorer__bar">
        <span className="explorer__root" title={rootName}>{rootName}</span>
        <button className="icon-btn" title="Refresh" onClick={() => { for (const d of open) void load(d) }} aria-label="Refresh">
          <Refresh size={13} />
        </button>
      </div>
      <div className="explorer__body" ref={body}>
        {render('.', 0)}
      </div>
    </div>
  )
}
