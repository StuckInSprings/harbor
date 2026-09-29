import { useEffect, useMemo, useState } from 'react'
import type { Prompt } from '../../shared/types'
import { navigateList } from '../lib/listNav'

/**
 * The prompt library lives in the composer's slash menu rather than on a screen
 * of its own — a prompt is something you reach for mid-sentence.
 */

/** {{name}} placeholders, in the order they first appear. */
export function variablesIn(body: string): string[] {
  const out: string[] = []
  for (const m of body.matchAll(/\{\{\s*([a-zA-Z0-9_ -]+)\s*\}\}/g)) {
    const name = m[1].trim()
    if (!out.includes(name)) out.push(name)
  }
  return out
}

export function fillVariables(body: string, values: Record<string, string>): string {
  return body.replace(/\{\{\s*([a-zA-Z0-9_ -]+)\s*\}\}/g, (_m, name: string) => {
    const key = name.trim()
    return values[key] ?? ''
  })
}

/*
  Built-in commands share the slash menu with saved prompts. They act rather
  than insert text, so they are listed first and never filtered out by a
  saved prompt that happens to share a prefix.
*/
export const COMMANDS: { name: string; hint: string; takesText?: boolean }[] = [
  {
    name: 'compact',
    hint: 'Summarise the older messages onto a fresh branch, keeping the original.'
  },
  {
    name: 'goal',
    hint: '/goal <condition> [$dollars] — work toward it on its own until a judge says it is met. /goal off stops.',
    takesText: true
  }
]

type Item = { kind: 'command'; name: string; hint: string; takesText?: boolean } | { kind: 'prompt'; prompt: Prompt }

interface Props {
  prompts: Prompt[]
  /** Text after the slash, used to filter. */
  filter: string
  onPick: (prompt: Prompt) => void
  onCommand: (name: string, args?: string) => void
  onClose: () => void
}

export function PromptMenu({ prompts, filter, onPick, onCommand, onClose }: Props): React.JSX.Element {
  const [selected, setSelected] = useState(0)

  const shown = useMemo<Item[]>(() => {
    const q = filter.trim().toLowerCase()
    // A command that takes text matches when the query begins with its name: "/goal build it" is /goal.
    const first = q.split(/\s+/)[0] ?? ''
    const commands: Item[] = COMMANDS.filter((c) => !q || c.name.includes(q) || (c.takesText && c.name === first)).map((c) => ({
      kind: 'command',
      ...c
    }))
    const matched = q ? prompts.filter((p) => p.name.toLowerCase().includes(q)) : prompts
    return [...commands, ...matched.map<Item>((p) => ({ kind: 'prompt', prompt: p }))].slice(0, 9)
  }, [prompts, filter])

  const pick = (item: Item): void => {
    if (item.kind === 'command') onCommand(item.name, item.takesText ? filter.trim().slice(item.name.length).trim() : undefined)
    else onPick(item.prompt)
  }

  useEffect(() => setSelected(0), [filter])

  // Owned here rather than in the composer so arrow keys work while typing.
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      const next = navigateList(e.key, selected, shown.length)
      if (next !== null) {
        e.preventDefault()
        setSelected(next)
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        if (shown[selected]) {
          e.preventDefault()
          pick(shown[selected])
        }
      } else if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [shown, selected, onPick, onCommand, onClose])

  if (shown.length === 0) {
    return (
      <div className="pmenu">
        <div className="pmenu__empty">
          No saved prompts match. Write one in Settings to reuse it here.
        </div>
      </div>
    )
  }

  return (
    <div className="pmenu">
      {shown.map((item, i) =>
        item.kind === 'command' ? (
          <button
            key={`cmd:${item.name}`}
            className="pmenu__row"
            aria-current={i === selected}
            onMouseEnter={() => setSelected(i)}
            onClick={() => pick(item)}
          >
            <span className="pmenu__name">/{item.name}</span>
            <span className="pmenu__body">{item.hint}</span>
            <span className="row__badge">command</span>
          </button>
        ) : (
          <button
            key={item.prompt.id}
            className="pmenu__row"
            aria-current={i === selected}
            onMouseEnter={() => setSelected(i)}
            onClick={() => onPick(item.prompt)}
          >
            <span className="pmenu__name">/{item.prompt.name}</span>
            <span className="pmenu__body">{item.prompt.body.slice(0, 70)}</span>
            {item.prompt.projectId === null && <span className="row__badge">global</span>}
          </button>
        )
      )}
    </div>
  )
}

/** Asked only when a chosen prompt actually has placeholders. */
export function VariableForm({
  prompt,
  onDone,
  onCancel
}: {
  prompt: Prompt
  onDone: (text: string) => void
  onCancel: () => void
}): React.JSX.Element {
  const names = variablesIn(prompt.body)
  const [values, setValues] = useState<Record<string, string>>({})

  return (
    <div className="pvars">
      <div className="pvars__head sounding">/{prompt.name}</div>
      {names.map((name, i) => (
        <input
          key={name}
          className="input"
          autoFocus={i === 0}
          placeholder={name}
          value={values[name] ?? ''}
          onChange={(e) => setValues((v) => ({ ...v, [name]: e.target.value }))}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onDone(fillVariables(prompt.body, values))
            if (e.key === 'Escape') onCancel()
          }}
        />
      ))}
      <div className="pvars__actions">
        <button className="btn" onClick={onCancel}>
          Cancel
        </button>
        <button className="btn btn--primary" onClick={() => onDone(fillVariables(prompt.body, values))}>
          Insert
        </button>
      </div>
    </div>
  )
}
