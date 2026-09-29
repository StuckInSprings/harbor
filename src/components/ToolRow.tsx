import { useState } from 'react'
import type { Message, ToolRun } from '../../shared/types'
import { ChevronDown, ChevronRight } from './Icons'
import { toolRowFailed } from '../../shared/tools'

/**
 * Tool calls collapse to a single line. An agent transcript is unreadable
 * otherwise, and the detail is almost never what you want to see first.
 */

const VERB: Record<string, string> = {
  read_file: 'Read',
  list_dir: 'Listed',
  search: 'Searched',
  write_file: 'Wrote',
  edit_file: 'Edited',
  run_command: 'Ran',
  load_skill: 'Loaded skill',
  search_knowledge: 'Searched knowledge for',
  todo_write: 'Updated the checklist'
}

function summarise(calls: { name: string; subject: string }[]): string {
  if (calls.length === 1) {
    const c = calls[0]
    const verb = VERB[c.name] ?? c.name
    return c.name === 'todo_write' ? verb : `${verb} ${c.subject}`
  }
  const names = new Set(calls.map((c) => c.name))
  if (names.size === 1) {
    const verb = VERB[calls[0].name] ?? calls[0].name
    return `${verb} ${calls.length} times`
  }
  return `Ran ${calls.length} tools`
}

interface Props {
  calls: ToolRun[]
  /** Results already on disk, matched to their calls by id. */
  results: Map<string, Message>
  running: boolean
}

export function ToolRow({ calls, results, running }: Props): React.JSX.Element {
  const [open, setOpen] = useState(false)
  if (calls.length === 0) return <></>

  const failed = toolRowFailed(calls, (id) => results.get(id)?.content)

  return (
    <div className="tools">
      <button className="tools__head" onClick={() => setOpen((v) => !v)} data-failed={failed}>
        <span className="tools__chevron">
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </span>
        <span className="tools__label">{summarise(calls)}</span>
        {running && <span className="tools__spinner" aria-label="running" />}
      </button>

      {open && (
        <div className="tools__body">
          {calls.map((c) => {
            const result = c.result ?? results.get(c.callId)?.content ?? null
            return (
              <div className="tools__call" key={c.callId}>
                <div className="tools__name">
                  {c.name}
                  {c.subject && <span className="tools__subject"> {c.subject}</span>}
                </div>
                {c.args && c.args !== '{}' && <pre className="tools__pre">{prettyArgs(c.args)}</pre>}
                {result !== null && <pre className="tools__pre tools__pre--out">{result}</pre>}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function prettyArgs(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    return raw
  }
}
