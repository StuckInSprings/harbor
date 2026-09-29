import { StrictMode, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import '../styles/tokens.css'
import '../styles/launcher.css'
import { ago, clipPreview, CLIPBOARD_ENTRY, type Clip } from '../../shared/launcher'
import { navigateList } from '../lib/listNav'

interface Item {
  path: string
  name: string
  icon: string
  hint?: string
}

/*
  The launcher panel: an input and the eight best matches. Arrow keys move,
  Return opens, Escape hides. The top match is selected as you type, so the
  common case is the hotkey, two letters, Return.
*/
function Launcher(): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [items, setItems] = useState<Item[]>([])
  const [selected, setSelected] = useState(0)
  // The clipboard entry turns the panel into a list of what was copied; Escape turns it back.
  const [clips, setClips] = useState<Clip[] | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const latest = useRef(0)
  /*
    The panel opens under the pointer, and the row that happened to be there
    took the selection the moment the list rendered, so Return opened
    whatever the mouse was resting on. Hover counts only once the pointer
    has actually moved since the panel came up.
  */
  const pointerLive = useRef(false)
  const box = useRef<HTMLDivElement>(null)

  // The window is sized to the panel, margins included, whenever the panel's height changes.
  useEffect(() => {
    const el = box.current
    if (!el) return
    const fit = (): void => {
      void window.harbor.launcher.resize(Math.ceil(el.getBoundingClientRect().height) + 16)
    }
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const load = async (text: string): Promise<void> => {
    const stamp = ++latest.current
    const r = await window.harbor.launcher.query(text)
    if (stamp !== latest.current || !r.ok) return
    setItems(r.data ?? [])
    setSelected(0)
  }

  useEffect(() => {
    void load('')
    return window.harbor.launcher.onShow(() => {
      pointerLive.current = false
      setQuery('')
      setClips(null)
      void load('')
      input.current?.focus()
    })
  }, [])

  const open = (item: Item | undefined): void => {
    if (!item) return
    void window.harbor.launcher.open(item.path, query)
    if (item.path === CLIPBOARD_ENTRY) {
      void window.harbor.launcher.clips().then((r) => {
        setClips(r.ok ? (r.data ?? []) : [])
        setQuery('')
        setSelected(0)
        input.current?.focus()
      })
    }
  }

  const shownClips = clips === null ? [] : clips.filter((c) => !query.trim() || c.text.toLowerCase().includes(query.trim().toLowerCase()))
  const count = clips === null ? items.length : shownClips.length
  const now = Date.now()

  return (
    <div
      className="launcher"
      ref={box}
      onMouseDown={(e) => e.preventDefault()}
      onMouseMove={() => {
        pointerLive.current = true
      }}
    >
      <input
        ref={input}
        className="launcher__input"
        autoFocus
        spellCheck={false}
        placeholder={clips === null ? 'Open…' : 'Clipboard history'}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value)
          setSelected(0)
          if (clips === null) void load(e.target.value)
        }}
        onKeyDown={(e) => {
          const next = navigateList(e.key, selected, count)
          if (next !== null) {
            e.preventDefault()
            setSelected(next)
          } else if (e.key === 'Enter') {
            e.preventDefault()
            if (clips === null) open(items[selected])
            else if (shownClips[selected]) void window.harbor.launcher.pasteClip(shownClips[selected].id)
          } else if (e.key === 'Backspace' && (e.metaKey || e.ctrlKey) && clips === null && items[selected]) {
            // Raycast's gesture: this one's ranking forgotten, so it stops coming first.
            e.preventDefault()
            void window.harbor.launcher.forget(items[selected].path).then(() => load(query))
          } else if (e.key === 'Escape') {
            e.preventDefault()
            // Out of the clips first, then out of the panel.
            if (clips !== null) {
              setClips(null)
              setQuery('')
              void load('')
            } else void window.harbor.launcher.hide()
          }
        }}
      />
      {clips !== null && (
        <ul className="launcher__list">
          {shownClips.length === 0 && <li className="launcher__empty">{clips.length === 0 ? 'Nothing copied since Harbor started.' : 'No clip matches.'}</li>}
          {shownClips.map((c, i) => (
            <li
              key={c.id}
              className="launcher__item launcher__item--clip"
              data-selected={i === selected}
              onMouseMove={() => {
                if (pointerLive.current) setSelected(i)
              }}
              onClick={() => void window.harbor.launcher.pasteClip(c.id)}
            >
              <span className="launcher__index">{i + 1}</span>
              <span className="launcher__name">{clipPreview(c.text)}</span>
              <span className="launcher__hint">
                {c.text.length > 96 || c.text.includes('\n') ? `${c.text.length.toLocaleString()} chars · ` : ''}
                {ago(c.at, now)}
              </span>
            </li>
          ))}
          <li className="launcher__foot">Return pastes · Esc goes back · kept in memory only</li>
        </ul>
      )}
      {clips === null && items.length > 0 && (
        <ul className="launcher__list">
          {items.map((item, i) => (
            <li
              key={item.path}
              className="launcher__item"
              data-selected={i === selected}
              onMouseMove={() => {
                if (pointerLive.current) setSelected(i)
              }}
              onClick={() => open(item)}
            >
              {item.icon ? <img className="launcher__icon" src={item.icon} alt="" /> : <span className="launcher__icon" />}
              <span className="launcher__name">{item.name}</span>
              {item.hint && <span className="launcher__hint">{item.hint}</span>}
            </li>
          ))}
          {!query.trim() && <li className="launcher__foot">@ a project or conversation · ? a question · ⌘⌫ forgets a ranking</li>}
        </ul>
      )}
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Launcher />
  </StrictMode>
)
