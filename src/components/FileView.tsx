import { useEffect, useRef, useState } from 'react'
import { Markdown } from './Markdown'
import { ChevronLeft, ChevronRight, Code, Cross, Layers, Pencil, Plus, Wrap } from './Icons'
import { frontMatter } from '../../shared/globs'

const FRONT_MATTER = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/
import { Drafts } from './Drafts'
import { CodeEditor } from './CodeEditor'
import { languageFor } from '../lib/highlight'
import { notify } from '../lib/notices'
import { isAttachable, isImage, joinPath, parentOf } from '../../shared/files'
import { api } from '../lib/api'

/**
 * Reading a file from the project, in the inspector.
 *
 * Markdown renders; anything else is shown as highlighted source. The `</>`
 * control switches to raw text, which for a markdown file is the difference
 * between reading it and editing-eye reading it.
 */

const MARKDOWN = new Set(['.md', '.markdown', '.mdx'])

const extOf = (path: string): string => {
  const i = path.lastIndexOf('.')
  return i === -1 ? '' : path.slice(i).toLowerCase()
}

/** Language hint for the fence, so highlighting picks the right grammar. */
const LANG: Record<string, string> = {
  '.ts': 'typescript', '.tsx': 'tsx', '.js': 'javascript', '.jsx': 'jsx',
  '.py': 'python', '.rb': 'ruby', '.go': 'go', '.rs': 'rust', '.java': 'java',
  '.sh': 'bash', '.sql': 'sql', '.json': 'json', '.yaml': 'yaml', '.yml': 'yaml',
  '.css': 'css', '.html': 'html', '.xml': 'xml', '.toml': 'toml'
}

export function FileView({
  conversationId,
  path,
  reloadToken,
  onClose,
  onOpen,
  onAttach,
  onChanged
}: {
  conversationId: string | null
  path: string | null
  /** Bumped when the agent writes, so an open file shows the new contents. */
  reloadToken: number
  onClose: () => void
  /** Open another file in this pane — the next image along, say. */
  onOpen?: (path: string) => void
  onAttach?: (path: string) => void
  /** A version was restored or copied, so the file and the Changes pane moved. */
  onChanged?: () => void
}): React.JSX.Element {
  const [content, setContent] = useState<string | null>(null)
  const [image, setImage] = useState<string | null>(null)
  const [raw, setRaw] = useState(false)
  /*
    Wrapping is a reading preference, so it is remembered in this browser
    and on by default: a long line you cannot see the end of is worse than a
    ragged margin, and a file pane is narrow.
  */
  const [wrap, setWrap] = useState<boolean>(() => {
    try {
      return localStorage.getItem('harbor.wrap') !== '0'
    } catch {
      return true
    }
  })
  const toggleWrap = (): void =>
    setWrap((v) => {
      try {
        localStorage.setItem('harbor.wrap', v ? '0' : '1')
      } catch {
        // Not remembered, then.
      }
      return !v
    })
  const [history, setHistory] = useState(false)
  const [loading, setLoading] = useState(false)
  /*
    Editing. The draft is the person's; a write from the agent while it is
    open must not replace it, so a change on disk is only noted, with a way to
    take it. Saving goes through the same checkpointed write as everything
    else, so it shows in Changes and in the file's history.
  */
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [diskChanged, setDiskChanged] = useState(false)
  const editor = useRef<HTMLTextAreaElement>(null)
  const dirty = editing && content !== null && draft !== content
  /*
    Reviewing images means moving between them, so an image file also loads
    the list of its neighbours in the same folder.
  */
  const [siblings, setSiblings] = useState<string[]>([])

  useEffect(() => {
    if (!conversationId || !path) {
      setContent(null)
      setImage(null)
      return
    }
    let live = true
    setLoading(true)
    void (async () => {
      if (isImage(path)) {
        setEditing(false)
        const r = await api.workspace.readImage(conversationId, path)
        if (!live) return
        setLoading(false)
        setContent(null)
        if (r.ok && r.data) setImage(`data:${r.data.mime};base64,${r.data.base64}`)
        else {
          setImage(null)
          notify(r.error ?? `${path} could not be read.`)
        }
        const dir = parentOf(path)
        const t = await api.workspace.tree(conversationId, dir)
        if (live && t.ok && t.data) {
          setSiblings(t.data.filter((e) => e.kind === 'file' && isImage(e.name)).map((e) => joinPath(dir, e.name)))
        }
        return
      }
      setImage(null)
      setSiblings([])
      const r = await api.workspace.read(conversationId, path)
      if (!live) return
      setLoading(false)
      if (r.ok && typeof r.data === 'string') {
        // A reload while a draft is open keeps the draft and says the file moved.
        setContent((prev) => {
          if (editing && prev !== null && draft !== prev && r.data !== prev) setDiskChanged(true)
          return r.data as string
        })
      } else {
        setContent(null)
        notify(r.error ?? `${path} could not be read.`)
      }
    })()
    return () => {
      live = false
    }
  }, [conversationId, path, reloadToken])

  if (!path) {
    return (
      <p style={{ color: 'var(--ink-faint)', padding: 16 }}>
        Open a file from the conversation to read it here.
      </p>
    )
  }

  const ext = extOf(path)
  const isMarkdown = MARKDOWN.has(ext)

  const beginEdit = (): void => {
    if (content === null) return
    setDraft(content)
    setDiskChanged(false)
    setHistory(false)
    setEditing(true)
    setTimeout(() => editor.current?.focus(), 0)
  }
  const save = async (): Promise<void> => {
    if (!conversationId || !path || !dirty) return
    setSaving(true)
    const r = await api.workspace.write(conversationId, path, draft)
    setSaving(false)
    if (!r.ok) {
      notify(r.error ?? `${path} could not be saved.`)
      return
    }
    setContent(draft)
    setDiskChanged(false)
    onChanged?.()
  }
  const stopEditing = (): void => {
    if (dirty && !window.confirm('Discard the unsaved changes?')) return
    setEditing(false)
  }
  const editorKeys = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
      e.preventDefault()
      void save()
      return
    }
    if (e.key === 'Escape' && !dirty) {
      setEditing(false)
      return
    }
    // Tab indents rather than leaving the editor; code needs it, prose does not mind.
    if (e.key === 'Tab') {
      e.preventDefault()
      const el = e.currentTarget
      const { selectionStart: s, selectionEnd: end } = el
      const next = `${draft.slice(0, s)}  ${draft.slice(end)}`
      setDraft(next)
      requestAnimationFrame(() => el.setSelectionRange(s + 2, s + 2))
    }
  }
  // Front matter is for machines; rendered as markdown it comes out as a heading. Shown as a small table instead.
  const fm = !image && !raw && content !== null && (path?.endsWith('.md') ?? false) ? frontMatter(content) : null
  const at = siblings.indexOf(path)
  const prev = at > 0 ? siblings[at - 1] : null
  const next = at !== -1 && at < siblings.length - 1 ? siblings[at + 1] : null

  return (
    <div className="fileview">
      <div className="fileview__bar">
        <span className="fileview__path" title={path}>
          {path}
        </span>
        {image && siblings.length > 1 && onOpen && (
          <span className="fileview__nav">
            <button className="icon-btn" disabled={!prev} onClick={() => prev && onOpen(prev)} title="Previous image" aria-label="Previous image">
              <ChevronLeft size={13} />
            </button>
            <span className="sounding">{at + 1}/{siblings.length}</span>
            <button className="icon-btn" disabled={!next} onClick={() => next && onOpen(next)} title="Next image" aria-label="Next image">
              <ChevronRight size={13} />
            </button>
          </span>
        )}
        {editing ? (
          <>
            <button className="icon-btn" aria-pressed={wrap} onClick={toggleWrap} title={wrap ? 'Long lines wrap; click to let them run' : 'Long lines run off the edge; click to wrap them'} aria-label={wrap ? 'Long lines wrap; click to let them run' : 'Long lines run off the edge; click to wrap them'}>
              <Wrap size={14} />
            </button>
            {dirty && <span className="fileview__dirty" title="Unsaved changes" />}
            <button className="btn" onClick={stopEditing} disabled={saving}>
              {dirty ? 'Discard' : 'Done'}
            </button>
            <button className="btn btn--primary" onClick={() => void save()} disabled={!dirty || saving}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          </>
        ) : (
          <>
            {onAttach && isAttachable(path) && (
              <button className="icon-btn" onClick={() => onAttach(path)} title="Attach to the next message" aria-label="Attach to the next message">
                <Plus size={14} />
              </button>
            )}
            {!image && content !== null && conversationId && (
              <button className="icon-btn" onClick={beginEdit} title="Edit this file" aria-label="Edit this file">
                <Pencil size={14} />
              </button>
            )}
            {!image && (
              <button
                className="icon-btn"
                aria-pressed={history}
                onClick={() => setHistory((v) => !v)}
                title={history ? 'Back to the file' : 'Versions of this file'}
               aria-label={history ? 'Back to the file' : 'Versions of this file'}>
                <Layers size={14} />
              </button>
            )}
            {!image && !history && (
              <button className="icon-btn" aria-pressed={wrap} onClick={toggleWrap} title={wrap ? 'Long lines wrap; click to let them run' : 'Long lines run off the edge; click to wrap them'} aria-label={wrap ? 'Long lines wrap; click to let them run' : 'Long lines run off the edge; click to wrap them'}>
                <Wrap size={14} />
              </button>
            )}
            {!image && !history && (
              <button
                className="icon-btn"
                aria-pressed={raw}
                onClick={() => setRaw((v) => !v)}
                title={raw ? 'Show it rendered' : 'Show the source'}
               aria-label={raw ? 'Show it rendered' : 'Show the source'}>
                <Code size={14} />
              </button>
            )}
            <button className="icon-btn" onClick={onClose} title="Close file" aria-label="Close file">
              <Cross size={14} />
            </button>
          </>
        )}
      </div>

      {editing && diskChanged && (
        <div className="fileview__notice">
          <span>This file changed on disk while you were editing.</span>
          <button
            className="btn"
            onClick={() => {
              if (content !== null) setDraft(content)
              setDiskChanged(false)
            }}
          >
            Take the new version
          </button>
        </div>
      )}

      <div className="fileview__body" data-image={!!image} data-editing={editing} data-wrap={wrap}>
        {loading && <p className="hint">Reading…</p>}
        {image && <img className="fileview__img" src={image} alt={path} />}
        {editing && (
          <CodeEditor
            inputRef={editor}
            value={draft}
            language={languageFor(path)}
            spellCheck={isMarkdown}
            onChange={setDraft}
            onKeyDown={editorKeys}
            wrap={wrap}
          />
        )}
        {!editing && history && !image && conversationId && (
          <Drafts
            conversationId={conversationId}
            path={path}
            current={content}
            onChanged={() => onChanged?.()}
          />
        )}
        {!editing &&
          !history &&
          content !== null &&
          (raw ? (
            <pre className="fileview__raw">{content}</pre>
          ) : isMarkdown ? (
            <>
              {fm && (
                <dl className="fileview__meta">
                  {Object.entries(fm).map(([k, v]) => (
                    <div key={k} className="fileview__meta-row" data-key={k}>
                      <dt>{k.replace(/_/g, ' ')}</dt>
                      <dd>{v}</dd>
                    </div>
                  ))}
                </dl>
              )}
              <Markdown text={fm ? content.replace(FRONT_MATTER, '') : content} />
            </>
          ) : (
            <Markdown text={'```' + (LANG[ext] ?? '') + '\n' + content + '\n```'} />
          ))}
      </div>
    </div>
  )
}
