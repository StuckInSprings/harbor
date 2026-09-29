import { useCallback, useEffect, useState } from 'react'
import type { IndexProgress, KnowledgeSource, Memory, Project, Skill } from '../../shared/types'
import { Plus, Refresh, Star, Trash } from './Icons'
import { ok } from '../lib/notices'
import { Sheet } from './Sheet'
import { api } from '../lib/api'

/**
 * One destination, three tabs, mirroring the channels in
 * docs/CONTEXT-MODEL.md: a skill is a procedure, knowledge is what was written
 * down, memory is what was learned by doing.
 */

type Tab = 'skills' | 'knowledge' | 'memory'

const TABS: { key: Tab; label: string; blurb: string }[] = [
  { key: 'skills', label: 'Skills', blurb: 'Procedures the agent should follow, step by step.' },
  {
    key: 'knowledge',
    label: 'Knowledge',
    blurb: 'Documents and notes it can search and cite. Separate from the code it edits.'
  },
  {
    key: 'memory',
    label: 'Memory',
    blurb: 'What it learned by working with you. Written automatically, yours to revoke.'
  }
]

export function ContextSheet({
  project,
  onClose
}: {
  project: Project | null
  onClose: () => void
}): React.JSX.Element {
  const [tab, setTab] = useState<Tab>('skills')

  return (
    <Sheet title="Context" panel="sheet__panel--tall" aside={project && <span className="sounding">{project.name}</span>} onClose={onClose}>
        <div className="tabs" role="tablist">
          {TABS.map((t) => (
            <button
              key={t.key}
              className="tabs__tab"
              role="tab"
              aria-selected={tab === t.key}
              onClick={() => setTab(t.key)}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="sheet__body">
          <p className="tabs__blurb">{TABS.find((t) => t.key === tab)!.blurb}</p>
          {!project ? (
            <p className="hint">Open a project first.</p>
          ) : tab === 'skills' ? (
            <Skills project={project} />
          ) : tab === 'knowledge' ? (
            <Knowledge project={project} />
          ) : (
            <Memories project={project} />
          )}
        </div>
    </Sheet>
  )
}

/* ---------------------------------------------------------------- skills */

function Skills({ project }: { project: Project }): React.JSX.Element {
  const [items, setItems] = useState<Skill[] | null>(null)
  const [editing, setEditing] = useState<Skill | 'new' | null>(null)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [body, setBody] = useState('')

  const load = useCallback(async () => {
    const r = await api.skills.list(project.id)
    if (r.ok && r.data) setItems(r.data)
  }, [project.id])

  useEffect(() => {
    void load()
  }, [load])

  const open = (skill: Skill | 'new'): void => {
    setEditing(skill)
    setName(skill === 'new' ? '' : skill.name)
    setDescription(skill === 'new' ? '' : skill.description)
    setBody(skill === 'new' ? '' : skill.body)
  }

  const save = async (): Promise<void> => {
    if (!name.trim()) return
    if (!ok(await api.skills.save(project.id, name, description, body))) return
    setEditing(null)
    await load()
  }

  const remove = async (skill: Skill): Promise<void> => {
    await api.skills.remove(skill.projectId, skill.name)
    setEditing(null)
    await load()
  }

  if (editing) {
    return (
      <div>
        <label className="field">
          <span className="field__label">Name</span>
          <input
            className="input input--mono"
            autoFocus
            value={name}
            placeholder="release-check"
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label className="field">
          <span className="field__label">When to use it</span>
          <input
            className="input"
            value={description}
            placeholder="Steps to verify a build before tagging a release"
            onChange={(e) => setDescription(e.target.value)}
          />
          <span className="field__hint">
            This line is all the model sees until it loads the skill, so make it say when
            the procedure applies.
          </span>
        </label>
        <label className="field">
          <span className="field__label">Procedure</span>
          <textarea
            className="input"
            rows={12}
            value={body}
            placeholder={'1. Run the tests\n2. Check the changelog is current\n3. …'}
            onChange={(e) => setBody(e.target.value)}
            style={{ resize: 'vertical', lineHeight: 1.55, fontFamily: 'var(--font-mono)' }}
          />
        </label>
        <div className="row-of">
          <button className="btn btn--primary" disabled={!name.trim()} onClick={() => void save()}>
            Save skill
          </button>
          <button className="btn" onClick={() => setEditing(null)}>
            Cancel
          </button>
          {editing !== 'new' && (
            <button className="btn btn--danger" onClick={() => void remove(editing)}>
              Delete
            </button>
          )}
        </div>
      </div>
    )
  }

  return (
    <div>
      {items !== null && items.length === 0 && (
        <p className="hint">
          No skills yet. Write one when you find yourself explaining the same steps twice.
        </p>
      )}
      {(items ?? []).map((s) => (
        <button className="ctx-row" key={`${s.projectId}-${s.name}`} onClick={() => open(s)}>
          <span className="ctx-row__main">
            <code className="ctx-row__name">{s.name}</code>
            <span className="ctx-row__sub">{s.description || 'no description'}</span>
          </span>
          {s.projectId === null && <span className="row__badge">global</span>}
        </button>
      ))}
      <button className="btn mt-3" onClick={() => open('new')}>
        <span className="row-of row-of--inline">
          <Plus size={13} />
          New skill
        </span>
      </button>
    </div>
  )
}

/* ------------------------------------------------------------- knowledge */

function Knowledge({ project }: { project: Project }): React.JSX.Element {
  const [sources, setSources] = useState<KnowledgeSource[] | null>(null)
  const [progress, setProgress] = useState<Record<string, string>>({})
  const [vector, setVector] = useState(true)

  const load = useCallback(async () => {
    const r = await api.knowledge.sources(project.id)
    if (r.ok && r.data) setSources(r.data)
  }, [project.id])

  useEffect(() => {
    void load()
    void (async () => {
      const v = await api.knowledge.hasVectorSearch()
      if (v.ok) setVector(v.data === true)
    })()
  }, [load])

  useEffect(() => {
    return api.knowledge.onProgress((p: IndexProgress) => {
      setProgress((all) => ({
        ...all,
        [p.sourceId]:
          p.state === 'indexing'
            ? p.total
              ? `Indexing ${p.done + 1} of ${p.total} — ${p.file}`
              : 'Preparing the embedding model…'
            : p.state === 'done'
              ? `Indexed ${p.chunks} passages from ${p.files} files`
              : `Failed: ${p.message}`
      }))
      if (p.state !== 'indexing') void load()
    })
  }, [load])

  const add = async (): Promise<void> => {
    const picked = await api.knowledge.pick()
    if (!picked.ok || !picked.data?.length) return
    for (const path of picked.data) {
      ok(await api.knowledge.add(project.id, path), `${path} could not be added.`)
    }
    await load()
  }

  return (
    <div>
      {!vector && (
        <div className="note">
          Vector search is unavailable on this machine, so knowledge falls back to keyword
          matching alone. Exact terms still work; paraphrases will not.
        </div>
      )}

      {sources !== null && sources.length === 0 && (
        <p className="hint">
          Nothing added yet. Point this at docs, notes or transcripts — anything written
          down that you want answers grounded in.
        </p>
      )}

      {(sources ?? []).map((s) => (
        <div className="ctx-row ctx-row--static" key={s.id}>
          <span className="ctx-row__main">
            <code className="ctx-row__name">{s.path}</code>
            <span className="ctx-row__sub">
              {progress[s.id] ?? `${s.chunks} passages indexed`}
            </span>
          </span>
          <button
            className="icon-btn"
            title="Re-index"
            onClick={() => void api.knowledge.reindex(s.id, project.id, s.path)}
           aria-label="Re-index">
            <Refresh size={13} />
          </button>
          <button
            className="icon-btn"
            title="Remove"
            onClick={async () => {
              await api.knowledge.remove(s.id)
              await load()
            }}
           aria-label="Remove">
            <Trash size={13} />
          </button>
        </div>
      ))}

      <button className="btn mt-3" onClick={() => void add()}>
        <span className="row-of row-of--inline">
          <Plus size={13} />
          Add files or a folder
        </span>
      </button>
      <p className="field__hint">
        The first index downloads a small embedding model, once. After that everything runs
        on this machine.
      </p>
    </div>
  )
}

/* ---------------------------------------------------------------- memory */

function Memories({ project }: { project: Project }): React.JSX.Element {
  const [items, setItems] = useState<Memory[] | null>(null)
  const [draft, setDraft] = useState('')

  const load = useCallback(async () => {
    const r = await api.memory.list(project.id)
    if (r.ok && r.data) setItems(r.data)
  }, [project.id])

  useEffect(() => {
    void load()
  }, [load])

  const addOwn = async (): Promise<void> => {
    if (!draft.trim()) return
    if (!ok(await api.memory.add(project.id, draft.trim()))) return
    setDraft('')
    await load()
  }

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
        <input
          className="input"
          placeholder="Write something it should remember"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void addOwn()
          }}
        />
        <button className="btn" disabled={!draft.trim()} onClick={() => void addOwn()}>
          Add
        </button>
      </div>

      {items !== null && items.length === 0 && (
        <p className="hint">
          Nothing remembered yet. Harbor writes here on its own after a conversation, and
          every entry says where it came from.
        </p>
      )}

      {(items ?? []).map((m) => (
        <div className="mem" key={m.id} data-off={!m.enabled} data-new={!m.reviewed || undefined} data-stale={!!m.invalidatedAt || undefined}>
          <label className="mem__toggle">
            <input
              type="checkbox"
              checked={m.enabled}
              onChange={async (e) => {
                await api.memory.setEnabled(m.id, e.target.checked)
                await load()
              }}
            />
          </label>
          <div className="mem__main">
            <div className="mem__text">{m.text}</div>
            <div className="sounding mem__prov">
              {m.extractedBy ? `${m.origin === 'person' ? 'you said it' : 'the model concluded it'}, via ${m.extractedBy.split('/').pop()}` : 'written by you'}
              {' · '}
              {new Date(m.createdAt).toLocaleDateString()}
              {m.lastUsedAt ? ` · last used ${new Date(m.lastUsedAt).toLocaleDateString()}` : ''}
              {m.invalidatedAt ? ` · no longer holds since ${new Date(m.invalidatedAt).toLocaleDateString()}${m.invalidatedBy ? `: ${m.invalidatedBy}` : ''}` : ''}
            </div>
            {!m.reviewed && (
              <div className="mem__review">
                <span className="sounding">New, not yet used.</span>
                <button
                  className="btn btn--small btn--primary"
                  onClick={async () => {
                    await api.memory.review(m.id, true)
                    await load()
                  }}
                >
                  Keep
                </button>
                <button
                  className="btn btn--small"
                  onClick={async () => {
                    await api.memory.review(m.id, false)
                    await load()
                  }}
                >
                  Drop
                </button>
              </div>
            )}
          </div>
          <button
            className="icon-btn star"
            data-on={m.pinned}
            title={m.pinned ? 'Unpin' : 'Pin so it survives the budget'}
            onClick={async () => {
              await api.memory.setPinned(m.id, !m.pinned)
              await load()
            }}
           aria-label={m.pinned ? 'Unpin' : 'Pin so it survives the budget'}>
            <Star size={13} />
          </button>
          <button
            className="icon-btn"
            title="Forget"
            onClick={async () => {
              await api.memory.remove(m.id)
              await load()
            }}
           aria-label="Forget">
            <Trash size={13} />
          </button>
        </div>
      ))}
    </div>
  )
}
