import { useCallback, useEffect, useState } from 'react'
import type { KeyStatus, ModelInfo, Project, Prompt } from '../../shared/types'
import { Plus, Trash } from './Icons'
import { formatCost, shortModel } from '../lib/format'
import { handled, notify, ok } from '../lib/notices'
import {
  DEFAULT_ROUTING,
  parseFallbacks,
  parseRouting,
  serialiseRouting,
  type Routing,
  type Sort
} from '../../shared/routing'
import { Sheet } from './Sheet'
import { api } from '../lib/api'
import type { BridgeStatus } from '../../shared/bridge'

interface Props {
  status: KeyStatus | null
  project: Project | null
  models: ModelInfo[]
  onSave: (key: string) => Promise<string | null>
  onClear: () => void
  onClose: () => void
}

/*
  One page of twenty fields was a scroll with no landmarks. Six sections,
  each a screen, each fetching only its own settings when it opens; the
  last one chosen is the one that opens next time.
*/
type Section = 'models' | 'agent' | 'notifications' | 'integrations' | 'launcher' | 'prompts'
const SECTIONS: { id: Section; label: string; blurb: string }[] = [
  { id: 'models', label: 'Models', blurb: 'the key, routing, and the local server' },
  { id: 'agent', label: 'Agent', blurb: 'how far a turn may go on its own' },
  { id: 'notifications', label: 'Notifications', blurb: 'when the desktop should say' },
  { id: 'integrations', label: 'Integrations', blurb: 'Claude, MCP servers, traces' },
  { id: 'launcher', label: 'Launcher', blurb: 'the key, the favourites, the ranking' },
  { id: 'prompts', label: 'Prompts', blurb: 'slash commands you wrote' }
]
const SECTION_KEY = 'harbor.settings.section'
const readSection = (): Section => {
  try {
    const v = localStorage.getItem(SECTION_KEY)
    return SECTIONS.some((x) => x.id === v) ? (v as Section) : 'models'
  } catch {
    return 'models'
  }
}

export function Settings({
  status,
  project,
  models,
  onSave,
  onClear,
  onClose
}: Props): React.JSX.Element {
  const [section, setSectionState] = useState<Section>(() => readSection())
  const setSection = (id: Section): void => {
    setSectionState(id)
    try {
      localStorage.setItem(SECTION_KEY, id)
    } catch {
      // Then it opens on Models next time.
    }
  }
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = async (): Promise<void> => {
    if (!value.trim()) return
    setBusy(true)
    setError(null)
    const err = await onSave(value.trim())
    setBusy(false)
    if (err) setError(err)
    else setValue('')
  }

  return (
    <Sheet title="Settings" panel="sheet__panel--wide" aside={<span className="sounding">{SECTIONS.find((x) => x.id === section)?.blurb}</span>} onClose={onClose}>

        <div className="settings">
          <div className="settings__rail" role="tablist" aria-label="Settings sections">
            {SECTIONS.map((sec) => (
              <button key={sec.id} className="settings__tab" role="tab" aria-selected={section === sec.id} onClick={() => setSection(sec.id)}>
                {sec.label}
              </button>
            ))}
          </div>
          <div className="settings__body" role="tabpanel">
            {section === 'models' && (
              <>
          {status?.present ? (
            <div className="note note--good">
              Key stored{status.label ? ` — ${status.label}` : ''}.
              {status.usage !== undefined && (
                <>
                  {' '}
                  Used {formatCost(status.usage)}
                  {status.limit ? ` of ${formatCost(status.limit)}` : ' so far'}.
                </>
              )}
            </div>
          ) : (
            <div className="note">
              Harbor needs an OpenRouter key to talk to any model. Create one at
              openrouter.ai, then paste it below.
            </div>
          )}

          {error && <div className="note note--bad">{error}</div>}

          <label className="field">
            <span className="field__label">OpenRouter API key</span>
            <input
              className="input input--mono"
              type="password"
              placeholder="sk-or-v1-…"
              value={value}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void save()
              }}
            />
            <span className="field__hint">
              Encrypted with the macOS Keychain and kept out of the project folder. It stays
              in the main process and is never handed to the interface.
            </span>
          </label>

          <div className="row-of">
            <button className="btn btn--primary" disabled={busy || !value.trim()} onClick={save}>
              {busy ? 'Checking…' : status?.present ? 'Replace key' : 'Save key'}
            </button>
            {status?.present && (
              <button className="btn btn--danger" onClick={onClear}>
                Remove key
              </button>
            )}
          </div>

                <ExtractionModel models={models} />
                <RoutingPrefs models={models} />
                <LocalEndpoint />
              </>
            )}
            {section === 'agent' && (
              <>
                <GlobalPrompt />
                <StepCeiling />
                <SandboxSettings />
                <ApprovalMode />
                <MemoryReview />
              </>
            )}
            {section === 'notifications' && (
              <>
                <NotifyApprovals />
                <NotifyReplies />
              </>
            )}
            {section === 'integrations' && (
              <>
                <ClaudeBridge />
                <McpSettings />
                <Telemetry />
              </>
            )}
            {section === 'launcher' && (
              <>
                <LauncherHotkey />
                <LauncherFavourites />
                <LauncherRanking />
              </>
            )}
            {section === 'prompts' && <Prompts project={project} />}
          </div>
        </div>
    </Sheet>
  )
}

/* Applies to every project, ahead of that project's own instructions. */
function GlobalPrompt(): React.JSX.Element {
  const [value, setValue] = useState('')
  const [saved, setSaved] = useState(true)

  useEffect(() => {
    void (async () => {
      const r = await api.settings.get('global_prompt')
      if (r.ok) setValue(r.data ?? '')
    })()
  }, [])

  return (
    <label className="field">
      <span className="field__label">Global instructions</span>
      <textarea
        className="input"
        rows={4}
        value={value}
        placeholder="How you want the model to work, in every project."
        onChange={(e) => {
          setValue(e.target.value)
          setSaved(false)
        }}
        onBlur={() => {
          void api.settings.set('global_prompt', value)
          setSaved(true)
        }}
        style={{ resize: 'vertical', lineHeight: 1.55 }}
      />
      <span className="field__hint">
        Sent ahead of each project's own instructions. {saved ? '' : 'Unsaved — click away to save.'}
      </span>
    </label>
  )
}

/*
  Which providers may serve a request, and what happens when one fails. Every
  field is off by default, and an off field sends nothing, so the request is
  unchanged until something here is set.
*/
function RoutingPrefs({ models }: { models: ModelInfo[] }): React.JSX.Element {
  const [routing, setRouting] = useState<Routing>(DEFAULT_ROUTING)
  const [fallbackText, setFallbackText] = useState('')
  const [ignoreText, setIgnoreText] = useState('')

  useEffect(() => {
    void (async () => {
      const r = await api.settings.get('routing')
      if (!r.ok) return
      const parsed = parseRouting(r.data)
      setRouting(parsed)
      setFallbackText(parsed.fallbacks.join('\n'))
      setIgnoreText(parsed.ignore.join('\n'))
    })()
  }, [])

  const save = (next: Routing): void => {
    setRouting(next)
    void api.settings.set('routing', serialiseRouting(next))
  }

  // Ids that are not in the model list are still saved — they may be new —
  // but they are pointed out, since a typo here fails silently at the provider.
  const known = new Set(models.map((m) => m.id))
  const unknown = routing.fallbacks.filter((f) => models.length > 0 && !known.has(f))

  return (
    <>
      <label className="field field--row">
        <input
          type="checkbox"
          checked={routing.denyDataCollection}
          onChange={(e) => save({ ...routing, denyDataCollection: e.target.checked })}
        />
        <span>
          <span className="field__label">Only providers that do not train on prompts</span>
          <span className="field__hint">
            Asks OpenRouter to route around any provider that keeps what it receives. Some
            models have no such provider and will fail with this on.
          </span>
        </span>
      </label>

      <label className="field">
        <span className="field__label">Prefer providers by</span>
        <select
          className="input input--mono"
          value={routing.sort}
          onChange={(e) => save({ ...routing, sort: e.target.value as Sort })}
        >
          <option value="">OpenRouter's default</option>
          <option value="price">lowest price</option>
          <option value="throughput">highest throughput</option>
          <option value="latency">lowest latency</option>
        </select>
      </label>

      <label className="field">
        <span className="field__label">Fallback models</span>
        <textarea
          className="input input--mono"
          rows={3}
          value={fallbackText}
          placeholder={'one model id per line, e.g.\nanthropic/claude-sonnet-5\ngoogle/gemini-2.5-flash'}
          onChange={(e) => setFallbackText(e.target.value)}
          onBlur={() => save({ ...routing, fallbacks: parseFallbacks(fallbackText) })}
          style={{ resize: 'vertical', lineHeight: 1.55 }}
        />
        <span className="field__hint">
          Tried in order when the chosen model is rate limited or down, instead of ending the
          turn. The message then names the model that actually answered.
          {unknown.length > 0 && ` Not in the model list: ${unknown.join(', ')}.`}
        </span>
      </label>

      <label className="field">
        <span className="field__label">Providers to avoid</span>
        <textarea
          className="input input--mono"
          rows={2}
          value={ignoreText}
          placeholder={'one provider name per line, e.g.\nStreamLake'}
          onChange={(e) => setIgnoreText(e.target.value)}
          onBlur={() => save({ ...routing, ignore: parseFallbacks(ignoreText) })}
          style={{ resize: 'vertical', lineHeight: 1.55 }}
        />
        <span className="field__hint">
          Never routed to. Harbor adds a provider here itself when it drops a reply mid-stream, since one cut
          reply costs more than avoiding that provider; clear a line to give it another chance.
        </span>
      </label>
    </>
  )
}

/* A run waiting on a yes is stalled; when the window is not in front, the desktop should say so. */
function NotifyApprovals(): React.JSX.Element {
  const [on, setOn] = useState(true)
  useEffect(() => {
    void (async () => {
      const r = await api.settings.get('notify_approvals')
      if (r.ok) setOn(r.data !== '0')
    })()
  }, [])
  return (
    <label className="field">
      <span className="field__label">Desktop notifications</span>
      <label className="row-of row-of--top">
        <input
          type="checkbox"
          checked={on}
          onChange={(e) => {
            setOn(e.target.checked)
            void api.settings.set('notify_approvals', e.target.checked ? '1' : '0')
          }}
          className="check"
        />
        <span className="dim">
          Tell me on the desktop when a run needs my approval and this window is not in front. Clicking the
          notification opens the conversation that asked.
        </span>
      </label>
    </label>
  )
}

/* A reply that lands while the person is elsewhere is the second thing the desktop should say. */
function NotifyReplies(): React.JSX.Element {
  const [on, setOn] = useState(true)
  useEffect(() => {
    void (async () => {
      const r = await api.settings.get('notify_replies')
      if (r.ok) setOn(r.data !== '0')
    })()
  }, [])
  return (
    <label className="field">
      <label className="row-of row-of--top">
        <input
          type="checkbox"
          checked={on}
          onChange={(e) => {
            setOn(e.target.checked)
            void api.settings.set('notify_replies', e.target.checked ? '1' : '0')
          }}
          className="check"
        />
        <span className="dim">
          Tell me when a reply is ready and no Harbor window is in front. The first line of the reply is the
          notification; clicking it opens the conversation.
        </span>
      </label>
    </label>
  )
}

/* The launcher's key: an application by name, from anywhere. Registered the moment it is set, and the failure said here. */
function LauncherHotkey(): React.JSX.Element {
  const [value, setValue] = useState('')
  const [note, setNote] = useState('')
  useEffect(() => {
    void (async () => {
      const r = await api.launcher.hotkey()
      if (r.ok && r.data) {
        setValue(r.data.hotkey)
        if (!r.data.bound) setNote('Not registered: another app holds this key.')
      }
    })()
  }, [])
  return (
    <label className="field">
      <span className="field__label">Launcher hotkey</span>
      <input
        className="input input--mono"
        value={value}
        placeholder="CommandOrControl+Space"
        style={{ maxWidth: 260 }}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => {
          void api.launcher.setHotkey(value.trim()).then((r) => setNote(handled(r).ok ? '' : (r.error ?? 'Could not register the key.')))
        }}
      />
      <span className="field__hint" style={note ? { color: 'var(--port)' } : undefined}>
        {note || 'Opens or switches to an application by name. Electron accelerator form: CommandOrControl+Space, Alt+Space, CommandOrControl+Shift+K. Free the key in Raycast or Spotlight first.'}
      </span>
    </label>
  )
}

/* The apps a typed letter should land on, in the person's own order. */
function LauncherFavourites(): React.JSX.Element {
  const [value, setValue] = useState('')
  useEffect(() => {
    void (async () => {
      const r = await api.launcher.favourites()
      if (r.ok) setValue(r.data ?? '')
    })()
  }, [])
  return (
    <label className="field">
      <span className="field__label">Apps that come first</span>
      <textarea
        className="input input--mono"
        rows={7}
        spellCheck={false}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => void api.launcher.setFavourites(value)}
      />
      <span className="field__hint">
        One name per line, in the order you want them. A letter lands on the first of these whose name starts with it, ahead
        of anything else that starts the same way. A closer match still wins: type co and Visual Studio Code comes first,
        because Claude does not contain it.
      </span>
    </label>
  )
}

/* Traces to a collector: one span per turn, per model request, per tool run. Off until an endpoint is set. */
function Telemetry(): React.JSX.Element {
  const [url, setUrl] = useState('')
  const [headers, setHeaders] = useState('')
  useEffect(() => {
    void (async () => {
      const u = await api.settings.get('otel_endpoint')
      if (u.ok) setUrl(u.data ?? '')
      const h = await api.settings.get('otel_headers')
      if (h.ok) setHeaders(h.data ?? '')
    })()
  }, [])
  return (
    <label className="field">
      <span className="field__label">Traces</span>
      <span className="intro">
        An OpenTelemetry collector's OTLP/HTTP traces endpoint, such as http://localhost:4318/v1/traces. Every turn is a
        trace: the turn, each model request under it with tokens and cost, and each tool run. Empty means nothing is sent.
        The attribute names follow the GenAI conventions, which are not yet stable.
      </span>
      <input className="input" placeholder="http://localhost:4318/v1/traces" value={url} onChange={(e) => setUrl(e.target.value)} onBlur={() => void api.settings.set('otel_endpoint', url.trim())} />
      <textarea className="input input--mono mt-1h" rows={2} placeholder={'Headers, one per line: Authorization: Bearer …'} value={headers} onChange={(e) => setHeaders(e.target.value)} onBlur={() => void api.settings.set('otel_headers', headers)} />
    </label>
  )
}

/* How much use may lift an app past a better fit, and the counts forgotten when they are in the way. */
function LauncherRanking(): React.JSX.Element {
  const [value, setValue] = useState('medium')
  const [note, setNote] = useState('')
  useEffect(() => {
    void (async () => {
      const r = await api.launcher.sensitivity()
      if (r.ok && r.data) setValue(r.data)
    })()
  }, [])
  return (
    <div className="field">
      <span className="field__label">Ranking by use</span>
      <div className="row-of">
        <select
          className="input"
          style={{ maxWidth: 160 }}
          value={value}
          onChange={(e) => {
            setValue(e.target.value)
            void api.launcher.setSensitivity(e.target.value)
          }}
        >
          <option value="off">Off: ties only</option>
          <option value="low">Low</option>
          <option value="medium">Medium</option>
          <option value="high">High</option>
        </select>
        <button
          className="btn"
          onClick={() => {
            void api.launcher.resetRanking().then((r) => setNote(handled(r).ok ? 'Ranking reset.' : (r.error ?? 'Could not reset.')))
          }}
        >
          Reset ranking
        </button>
        {note && <span className="field__hint">{note}</span>}
      </div>
      <span className="field__hint">
        How far an app you open often may climb past one whose name fits what you typed better. It never climbs past an app
        that comes first. In the launcher, ⌘⌫ forgets one app's count.
      </span>
    </div>
  )
}

/* How far a turn may run on its own before it stops and asks; zero means it never stops for that reason. */
function StepCeiling(): React.JSX.Element {
  const [value, setValue] = useState('')
  useEffect(() => {
    void (async () => {
      const r = await api.settings.get('step_ceiling')
      if (r.ok) setValue(r.data ?? '')
    })()
  }, [])
  return (
    <label className="field">
      <span className="field__label">Tool calls per turn</span>
      <input
        className="input input--mono"
        value={value}
        placeholder="100"
        inputMode="numeric"
        style={{ maxWidth: 140 }}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => void api.settings.set('step_ceiling', value.trim())}
      />
      <span className="field__hint">
        A turn stops after this many tool calls and waits for you to say continue. Blank means a hundred. Zero
        means no limit: the Stop button and the budget are the only brakes. Directors and workers have their
        own ceiling and ignore this.
      </span>
    </label>
  )
}

/* Memory extraction and compaction summaries; neither should be on an expensive model. */
function ExtractionModel({ models }: { models: ModelInfo[] }): React.JSX.Element {
  const [value, setValue] = useState('')

  useEffect(() => {
    void (async () => {
      const r = await api.settings.get('extraction_model')
      if (r.ok) setValue(r.data ?? '')
    })()
  }, [])

  return (
    <label className="field">
      <span className="field__label">Model for housekeeping</span>
      <select
        className="input input--mono"
        value={value}
        onChange={(e) => {
          setValue(e.target.value)
          void api.settings.set('extraction_model', e.target.value)
        }}
      >
        <option value="">Whatever the conversation is using</option>
        {models.map((m) => (
          <option key={m.id} value={m.id}>
            {shortModel(m.id)}
          </option>
        ))}
      </select>
      <span className="field__hint">
        Writes memories after every turn and the summaries when a conversation is compacted, so
        a small fast model is usually the right choice. Empty means the conversation's own model.
      </span>
    </label>
  )
}

/* The library behind the composer's slash menu. */
function Prompts({ project }: { project: Project | null }): React.JSX.Element {
  const [items, setItems] = useState<Prompt[]>([])
  const [editing, setEditing] = useState<Prompt | 'new' | null>(null)
  const [name, setName] = useState('')
  const [body, setBody] = useState('')
  const [global, setGlobal] = useState(false)

  const load = useCallback(async () => {
    const r = await api.prompts.list(project?.id ?? null)
    if (r.ok && r.data) setItems(r.data)
  }, [project?.id])

  useEffect(() => {
    void load()
  }, [load])

  const open = (p: Prompt | 'new'): void => {
    setEditing(p)
    setName(p === 'new' ? '' : p.name)
    setBody(p === 'new' ? '' : p.body)
    setGlobal(p === 'new' ? false : p.projectId === null)
  }

  const save = async (): Promise<void> => {
    if (!name.trim()) return
    const saved = await api.prompts.save(
      editing === 'new' ? null : (editing as Prompt).id,
      global ? null : (project?.id ?? null),
      name,
      body
    )
    if (!ok(saved, 'That prompt could not be saved.')) return
    setEditing(null)
    await load()
  }

  if (editing) {
    return (
      <div className="field">
        <span className="field__label">
          {editing === 'new' ? 'New prompt' : `Editing /${(editing as Prompt).name}`}
        </span>
        <input
          className="input input--mono"
          autoFocus
          placeholder="review"
          value={name}
          onChange={(e) => setName(e.target.value)}
          style={{ marginBottom: 8 }}
        />
        <textarea
          className="input"
          rows={5}
          placeholder={'Review {{file}} for correctness and tell me what you would change.'}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          style={{ resize: 'vertical', lineHeight: 1.55 }}
        />
        <span className="field__hint">
          Wrap a blank in double braces to be asked for it on insert, like {'{{file}}'}.
        </span>
        <label
          style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '10px 0' }}
        >
          <input
            type="checkbox"
            checked={global}
            onChange={(e) => setGlobal(e.target.checked)}
            style={{ accentColor: 'var(--beacon)' }}
          />
          <span className="dim">Available in every project</span>
        </label>
        <div className="row-of">
          <button className="btn btn--primary" disabled={!name.trim()} onClick={() => void save()}>
            Save
          </button>
          <button className="btn" onClick={() => setEditing(null)}>
            Cancel
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="field">
      <span className="field__label">Prompts</span>
      <span className="field__hint" style={{ marginTop: 0, marginBottom: 8, display: 'block' }}>
        Type a slash in the composer to reach these.
      </span>
      {items.map((p) => (
        <div className="ctx-row ctx-row--static" key={p.id}>
          <button className="ctx-row__main" onClick={() => open(p)} style={{ textAlign: 'left' }}>
            <code className="ctx-row__name">/{p.name}</code>
            <span className="ctx-row__sub">{p.body.slice(0, 90)}</span>
          </button>
          {p.projectId === null && <span className="row__badge">global</span>}
          <button
            className="icon-btn"
            title="Delete"
            onClick={async () => {
              await api.prompts.remove(p.id)
              await load()
            }}
           aria-label="Delete">
            <Trash size={13} />
          </button>
        </div>
      ))}
      <button className="btn mt-2h" onClick={() => open('new')}>
        <span className="row-of row-of--inline">
          <Plus size={13} />
          New prompt
        </span>
      </button>
    </div>
  )
}

/*
  The shell the agent runs is fenced by the operating system. Off, and a
  command may do anything the person can; approval alone stands between a
  bad turn and the disk, and an unattended run has none.
*/
function SandboxSettings(): React.JSX.Element {
  const [on, setOn] = useState(true)
  const [domains, setDomains] = useState('')
  useEffect(() => {
    void (async () => {
      const r = await api.settings.get('sandbox_commands')
      if (r.ok) setOn(r.data !== '0')
      const d = await api.settings.get('sandbox_domains')
      if (d.ok) setDomains(d.data ?? '')
    })()
  }, [])
  return (
    <label className="field">
      <span className="field__label">Sandbox</span>
      <label className="row-of row-of--top">
        <input
          type="checkbox"
          checked={on}
          onChange={(e) => {
            setOn(e.target.checked)
            void api.settings.set('sandbox_commands', e.target.checked ? '1' : '0')
          }}
          className="check"
        />
        <span className="dim">
          Run the agent's commands in the system sandbox: writes only inside the project and scratch folders, no
          reading of key and token folders, network only to the domains below. A command that needs more asks to
          run outside it, and you are asked every time.
        </span>
      </label>
      <textarea
        className="input"
        rows={3}
        value={domains}
        placeholder="Domains the sandbox may reach, one per line. Empty means the usual registries and forges."
        onChange={(e) => setDomains(e.target.value)}
        onBlur={() => void api.settings.set('sandbox_domains', domains.trim())}
        style={{ fontFamily: 'var(--font-mono)', fontSize: 12, marginTop: 8 }}
      />
    </label>
  )
}

/* Between asking for every command and asking for none: a judge that sees only what the person said. */
function ApprovalMode(): React.JSX.Element {
  const [mode, setMode] = useState<'ask' | 'judge'>('ask')
  useEffect(() => {
    void (async () => {
      const r = await api.settings.get('approval_mode')
      if (r.ok) setMode(r.data === 'judge' ? 'judge' : 'ask')
    })()
  }, [])
  return (
    <label className="field">
      <span className="field__label">Command approval</span>
      <select
        className="input"
        value={mode}
        onChange={(e) => {
          const next = e.target.value === 'judge' ? 'judge' : 'ask'
          setMode(next)
          void api.settings.set('approval_mode', next)
        }}
      >
        <option value="ask">Ask me for every command that is not allowlisted</option>
        <option value="judge">Let a judge decide, and ask me when it will not</option>
      </select>
      <span style={{ color: 'var(--ink-dim)', fontSize: 12, marginTop: 6, display: 'block' }}>
        The judge is the housekeeping model. It is shown what you wrote in the conversation, the project's
        instructions and the command, never anything the agent read, and it runs commands that only read without
        asking anyone. Its denials come to you as the usual card, with its reason. Anything outside the sandbox
        is always your call; and after three denials in a row it stands aside for the rest of the turn.
      </span>
    </label>
  )
}

/* MCP servers: a list in JSON, since there are few and they change rarely, and what each is doing. */
/*
  Harbor as an MCP server, so Claude Code can orchestrate and judge a
  director run: Harbor writes, the person answers, Claude keeps it moving
  and reviews it for them. Off by default; the command below registers it
  with Claude Code, token and all.
*/
function ClaudeBridge(): React.JSX.Element {
  const [st, setSt] = useState<BridgeStatus | null>(null)
  const [port, setPort] = useState('')
  const [cap, setCap] = useState('')
  const [shown, setShown] = useState(false)
  const take = (r: { ok: boolean; data?: BridgeStatus }): void => {
    if (!r.ok || !r.data) return
    setSt(r.data)
    setPort(String(r.data.port))
    setCap(String(r.data.cap))
  }
  useEffect(() => {
    void api.bridge.status().then(take)
  }, [])
  const masked = st ? st.command.replace(/Bearer [^"]+/, 'Bearer ••••••••') : ''
  return (
    <div className="field">
      <span className="field__label">Claude Code</span>
      <label className="row-of row-of--top">
        <input
          type="checkbox"
          className="check"
          checked={!!st?.enabled}
          onChange={(e) => void api.bridge.configure({ enabled: e.target.checked }).then(take)}
        />
        <span className="dim">
          Let Claude Code orchestrate and judge director runs. Harbor writes, and Claude keeps the run moving:
          it starts the interview with your brief, starts the director from the requirements, approves the plan,
          and nudges it along. Its judgement of the work comes to you as a review in the run view, with
          suggestions you send on to the director or dismiss. It has no way to write a file. Harbor listens on
          this machine only, for a client holding the token below; ordinary chats are out of its reach, and every
          run it starts has a budget no larger than the cap.
        </span>
      </label>
      {st?.enabled && (
        <>
          <div className="row-of mt-1h">
            <label className="row-of">
              <span className="dim">Port</span>
              <input className="input input--narrow" inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value)} onBlur={() => { if (Number(port) !== st.port) void api.bridge.configure({ port: Number(port) }).then(take) }} />
            </label>
            <label className="row-of">
              <span className="dim">Most a run may spend, $</span>
              <input className="input input--narrow" inputMode="decimal" value={cap} onChange={(e) => setCap(e.target.value)} onBlur={() => { if (Number(cap) !== st.cap) void api.bridge.configure({ cap: Number(cap) }).then(take) }} />
            </label>
            <span className="sounding" style={{ color: st.running ? undefined : 'var(--cardinal)' }}>
              {st.running ? `Listening on ${st.url}` : st.error ?? 'Not listening'}
            </span>
          </div>
          <label className="row-of row-of--top mt-1h">
            <input type="checkbox" className="check" checked={st.answers} onChange={(e) => void api.bridge.configure({ answers: e.target.checked }).then(take)} />
            <span className="dim">
              Claude may answer for me. Off, you answer the interview and the workers' questions yourself, here,
              and Claude waits; that is what the interview is for. On, Claude relays your answers from what you
              told it, and says a thing is open where you had not decided it.
            </span>
          </label>
          <span className="intro mt-1h">Run this once in a terminal to register Harbor with Claude Code in every folder:</span>
          <code className="input input--mono" style={{ display: 'block', whiteSpace: 'pre-wrap', wordBreak: 'break-all', userSelect: 'all' }}>{shown ? st.command : masked}</code>
          <div className="row-of mt-1h">
            <button className="btn btn--small" onClick={() => { void navigator.clipboard.writeText(st.command).then(() => notify('Command copied, token included.', 'info')) }}>Copy command</button>
            <button className="btn btn--small" onClick={() => setShown((v) => !v)}>{shown ? 'Hide token' : 'Show token'}</button>
            <button
              className="btn btn--small"
              onClick={() => {
                void (async () => {
                  const sure = await api.dialog.confirm('Make a new token?', 'The old one stops working at once; run the new command in Claude Code to replace it.', 'New token')
                  if (sure.ok && sure.data) take(await api.bridge.newToken())
                })()
              }}
            >
              New token
            </button>
          </div>
        </>
      )}
    </div>
  )
}

function McpSettings(): React.JSX.Element {
  const [text, setText] = useState('')
  const [status, setStatus] = useState<{ servers: { name: string; transport: string; enabled: boolean; trusted: boolean; connected: boolean; tools: number; error: string | null }[]; error: string | null } | null>(null)
  const [busy, setBusy] = useState(false)
  const refresh = async (): Promise<void> => {
    const r = await api.mcp.status()
    if (r.ok && r.data) setStatus(r.data)
  }
  useEffect(() => {
    void (async () => {
      const r = await api.settings.get('mcp_servers')
      if (r.ok) setText(r.data ?? '')
      await refresh()
    })()
  }, [])
  return (
    <label className="field">
      <span className="field__label">MCP servers</span>
      <span className="intro">
        A JSON list. Each server has a name and either a command (with args, and env) or a url. Their tools do
        not enter the prompt until the model looks them up with find_tools. A tool that changes things asks you
        first, like a shell command, unless the server is marked trusted.
      </span>
      <textarea
        className="input"
        rows={6}
        value={text}
        placeholder={'[\n  { "name": "filesystem", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path"] },\n  { "name": "docs", "url": "https://example.com/mcp", "trusted": true }\n]'}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          void (async () => {
            setBusy(true)
            await api.settings.set('mcp_servers', text.trim())
            await new Promise((r) => setTimeout(r, 800))
            await refresh()
            setBusy(false)
          })()
        }}
        style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}
      />
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
        <button
          className="btn btn--small"
          disabled={busy}
          onClick={() => {
            void (async () => {
              setBusy(true)
              const r = await api.mcp.reconnect()
              if (r.ok && r.data) setStatus(r.data)
              setBusy(false)
            })()
          }}
        >
          {busy ? 'Connecting…' : 'Reconnect'}
        </button>
        {status?.error && <span className="sounding" style={{ color: 'var(--cardinal)' }}>{status.error}</span>}
      </div>
      {status && status.servers.length > 0 && (
        <ul style={{ margin: '8px 0 0', padding: 0, listStyle: 'none', fontSize: 12 }}>
          {status.servers.map((s) => (
            <li key={s.name} className="dim">
              <code>{s.name}</code> · {s.transport} ·{' '}
              {!s.enabled ? 'off' : s.connected ? `${s.tools} tool${s.tools === 1 ? '' : 's'}` : `not connected${s.error ? `: ${s.error}` : ''}`}
              {s.trusted ? ' · trusted' : ''}
            </li>
          ))}
        </ul>
      )}
    </label>
  )
}

/* Memory is written without being asked; this makes each new entry wait for a yes. */
function MemoryReview(): React.JSX.Element {
  const [on, setOn] = useState(false)
  useEffect(() => {
    void (async () => {
      const r = await api.settings.get('memory_review')
      if (r.ok) setOn(r.data === '1')
    })()
  }, [])
  return (
    <label className="field">
      <span className="field__label">Memory</span>
      <label className="row-of row-of--top">
        <input
          type="checkbox"
          checked={on}
          onChange={(e) => {
            setOn(e.target.checked)
            void api.settings.set('memory_review', e.target.checked ? '1' : '0')
          }}
          className="check"
        />
        <span className="dim">
          Show me each new memory before it is used. Off, a memory Harbor extracts goes into the next prompt
          at once; on, it waits in Context for a Keep or a Drop. A memory a later conversation contradicts is
          marked as no longer holding rather than deleted, either way.
        </span>
      </label>
    </label>
  )
}

/* A server on this machine that speaks the OpenAI dialect: Ollama, LM Studio, llama.cpp. Its models come in as local/<name>. */
function LocalEndpoint(): React.JSX.Element {
  const [url, setUrl] = useState('')
  const [key, setKey] = useState('')
  const [ctx, setCtx] = useState('')
  useEffect(() => {
    void (async () => {
      const u = await api.settings.get('local_base_url')
      if (u.ok) setUrl(u.data ?? '')
      const k = await api.settings.get('local_api_key')
      if (k.ok) setKey(k.data ?? '')
      const c = await api.settings.get('local_context_length')
      if (c.ok) setCtx(c.data ?? '')
    })()
  }, [])
  return (
    <label className="field">
      <span className="field__label">Local models</span>
      <span className="intro">
        A server on this machine or network that speaks the OpenAI chat dialect — Ollama at http://localhost:11434/v1,
        LM Studio at http://localhost:1234/v1, llama.cpp at http://localhost:8080/v1. Its models appear in the picker as
        local/… at no cost, after a refresh. Cheap housekeeping (the judge, memory, the oracle) can be pointed
        at one. These servers rarely say how large their window is; set it below.
      </span>
      <input className="input" placeholder="http://localhost:11434/v1" value={url} onChange={(e) => setUrl(e.target.value)} onBlur={() => void api.settings.set('local_base_url', url.trim())} />
      <input className="input mt-1h" placeholder="API key, if the server wants one" type="password" value={key} onChange={(e) => setKey(e.target.value)} onBlur={() => void api.settings.set('local_api_key', key.trim())} />
      <input className="input input--mono mt-1h" placeholder="Context window in tokens, 32768 by default" value={ctx} onChange={(e) => setCtx(e.target.value)} onBlur={() => void api.settings.set('local_context_length', ctx.trim())} />
    </label>
  )
}
