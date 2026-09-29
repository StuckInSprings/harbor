import { useEffect, useRef, useState } from 'react'
import type { LogLine } from '../../shared/types'
import { Folder } from './Icons'
import { Sheet } from './Sheet'
import { api } from '../lib/api'
import { clock } from '../lib/format'

/**
 * The log, live.
 *
 * Worth showing rather than only writing to a file, because the moment you
 * want it is while something is still stuck — and at that moment the useful
 * question is which step the elapsed time stopped moving past.
 */
export function LogSheet({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [lines, setLines] = useState<LogLine[]>([])
  const [path, setPath] = useState('')
  const [follow, setFollow] = useState(true)
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void (async () => {
      const r = await api.log.recent()
      if (r.ok && r.data) setLines(r.data)
      const p = await api.log.path()
      if (p.ok && p.data) setPath(p.data)
    })()
    return api.log.onLine((line) => setLines((all) => [...all, line].slice(-800)))
  }, [])

  useEffect(() => {
    if (follow) endRef.current?.scrollIntoView({ block: 'end' })
  }, [lines, follow])

  const copy = async (): Promise<void> => {
    await navigator.clipboard.writeText(
      lines
        .map(
          (l) =>
            `${clock(l.at)} ${l.level} ${l.scope} ${l.message}` +
            (l.detail ? ` ${JSON.stringify(l.detail)}` : '')
        )
        .join('\n')
    )
  }

  return (
    <Sheet
      title="Log"
      panel="sheet__panel--tall"
      onClose={onClose}
      actions={
        <>
          <button className="btn" aria-pressed={follow} onClick={() => setFollow((v) => !v)}>
            Follow
          </button>
          <button className="btn" onClick={() => void copy()}>
            Copy
          </button>
          <button className="icon-btn" onClick={() => void api.log.reveal()} title={path} aria-label="Show the log file">
            <Folder size={14} />
          </button>
        </>
      }
    >

        <div className="logview" onWheel={() => setFollow(false)}>
          {lines.length === 0 && <p className="hint">Nothing logged yet.</p>}
          {lines.map((l, i) => (
            <div className="logline" data-level={l.level} key={`${l.at}-${i}`}>
              <span className="logline__t">{clock(l.at)}</span>
              <span className="logline__scope">{l.scope}</span>
              <span className="logline__msg">{l.message}</span>
              {l.detail && <span className="logline__detail">{JSON.stringify(l.detail)}</span>}
            </div>
          ))}
          <div ref={endRef} />
        </div>
    </Sheet>
  )
}
