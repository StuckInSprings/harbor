import { useEffect, useMemo, useRef, useState } from 'react'
import type { Project, SearchResult } from '../../shared/types'
import { Cross } from './Icons'
import { Sheet } from './Sheet'
import { api } from '../lib/api'
import { navigateList } from '../lib/listNav'

/**
 * One box over everything Harbor holds. Results group by kind so a conversation
 * title and a memory that mention the same word do not fight for the same list.
 */

const KIND_LABEL: Record<SearchResult['kind'], string> = {
  conversation: 'Conversations',
  message: 'In conversations',
  memory: 'Memories',
  skill: 'Skills',
  prompt: 'Prompts'
}

const ORDER: SearchResult['kind'][] = ['conversation', 'message', 'memory', 'prompt', 'skill']

export function SearchSheet({
  projects,
  onOpen,
  onClose
}: {
  projects: Project[]
  onOpen: (conversationId: string) => void
  onClose: () => void
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  // True from the keystroke until the answer, so the empty line is not shown while the search is still out.
  const [pending, setPending] = useState(false)
  const [selected, setSelected] = useState(0)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current)
    if (query.trim().length < 2) {
      setResults([])
      setPending(false)
      return
    }
    setPending(true)
    // Debounced: typing should not fire a query per keystroke.
    timer.current = setTimeout(() => {
      void (async () => {
        const r = await api.search.all(query)
        if (r.ok && r.data) {
          setResults(r.data)
          setSelected(0)
        }
        setPending(false)
      })()
    }, 140)
  }, [query])

  const flat = useMemo(() => {
    const groups = ORDER.map((kind) => ({
      kind,
      items: results.filter((r) => r.kind === kind)
    })).filter((g) => g.items.length > 0)
    return { groups, list: groups.flatMap((g) => g.items) }
  }, [results])

  const open = (r: SearchResult): void => {
    if (r.conversationId) onOpen(r.conversationId)
    onClose()
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    const next = navigateList(e.key, selected, flat.list.length)
    if (next !== null) {
      e.preventDefault()
      setSelected(next)
    } else if (e.key === 'Enter' && flat.list[selected]) {
      open(flat.list[selected])
    }
  }

  const nameOf = (id: string | null): string =>
    projects.find((p) => p.id === id)?.name ?? ''

  let index = -1

  return (
    <Sheet
      title="Search"
      panel="sheet__panel--search"
      onClose={onClose}
      head={
        <div className="search__bar">
          <input
            className="search__input"
            autoFocus
            aria-label="Search conversations, memories and prompts"
            placeholder="Search conversations, memories and prompts"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
          />
          <button className="icon-btn" onClick={onClose} title="Close" aria-label="Close">
            <Cross />
          </button>
        </div>
      }
    >

        <div className="search__results">
          {query.trim().length >= 2 && !pending && flat.list.length === 0 && (
            <p className="search__empty">Nothing matches that.</p>
          )}
          {query.trim().length < 2 && (
            <p className="search__empty">
              Type at least two characters. Arrow keys move, Enter opens.
            </p>
          )}

          {flat.groups.map((group) => (
            <div key={group.kind}>
              <div className="search__group sounding">{KIND_LABEL[group.kind]}</div>
              {group.items.map((r, i) => {
                index++
                const here = index
                return (
                  <button
                    key={`${group.kind}-${i}-${r.title}`}
                    className="search__row"
                    aria-current={here === selected}
                    onMouseEnter={() => setSelected(here)}
                    onClick={() => open(r)}
                  >
                    <span className="search__main">
                      <span className="search__title">{r.title}</span>
                      {r.snippet && <span className="search__snippet">{r.snippet}</span>}
                    </span>
                    <span className="sounding">{nameOf(r.projectId)}</span>
                  </button>
                )
              })}
            </div>
          ))}
        </div>
    </Sheet>
  )
}
