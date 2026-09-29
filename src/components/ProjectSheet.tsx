import { useEffect, useState } from 'react'
import type {
  AllowedCommand,
  Hook,
  ModelInfo,
  ModelParams,
  Project,
  Unlockable
} from '../../shared/types'
import { Folder } from './Icons'
import { formatCost, shortModel } from '../lib/format'
import { Parameters } from './Parameters'
import { parseFallbacks } from '../../shared/routing'
import { DEFAULT_TIERS, formatTiers, parseTiers } from '../../shared/tiers'
import { Sheet } from './Sheet'
import { api } from '../lib/api'

const LOCKS: { key: Unlockable; paths: string; why: string }[] = [
  { key: 'git', paths: '.git .svn .hg', why: 'version control internals' },
  { key: 'deps', paths: 'node_modules', why: 'installed dependencies' },
  { key: 'env', paths: '.env*', why: 'usually holds secrets' },
  { key: 'keys', paths: '*.pem *.key id_rsa', why: 'keys and certificates' }
]

interface Props {
  project: Project | null
  models: ModelInfo[]
  spend: number
  onSave: (patch: Partial<Project>) => void
  onDelete: (() => void) | null
  onClose: () => void
}

/** Used for both "new project" (project === null) and editing an existing one. */
export function ProjectSheet({
  project,
  models,
  spend,
  onSave,
  onDelete,
  onClose
}: Props): React.JSX.Element {
  const [name, setName] = useState(project?.name ?? '')
  const [rootPath, setRootPath] = useState(project?.rootPath ?? null)
  useEffect(() => {
    if (!rootPath) {
      setIsRepo(null)
      return
    }
    let stale = false
    void api.projects.isRepo(rootPath).then((r) => {
      if (!stale) setIsRepo(r.ok ? (r.data ?? null) : null)
    })
    return () => {
      stale = true
    }
  }, [rootPath])
  const [systemPrompt, setSystemPrompt] = useState(project?.systemPrompt ?? '')
  const [defaultModel, setDefaultModel] = useState(project?.defaultModel ?? '')
  const [unlocked, setUnlocked] = useState<Unlockable[]>(project?.unlocked ?? [])
  const [systemAsUser, setSystemAsUser] = useState(project?.systemAsUser ?? false)
  const [autoApprove, setAutoApprove] = useState(project?.autoApprove ?? false)
  const [tiersText, setTiersText] = useState(project?.tiers ?? '')
  // Auto-approve only holds inside a repository, so the sheet says whether the folder is one.
  const [isRepo, setIsRepo] = useState<boolean | null>(null)
  const [params, setParams] = useState<ModelParams>(project?.params ?? {})
  const [hooks, setHooks] = useState<Hook[]>(project?.hooks ?? [])
  const [writeGlobsText, setWriteGlobsText] = useState((project?.writeGlobs ?? []).join('\n'))
  const [contextFilesText, setContextFilesText] = useState((project?.contextFiles ?? []).join('\n'))
  const [confirming, setConfirming] = useState(false)
  const [allowed, setAllowed] = useState<AllowedCommand[]>([])

  // Everything the agent may run here without asking again.
  useEffect(() => {
    if (!project) return
    void (async () => {
      const r = await api.commands.allowed(project.id)
      if (r.ok && r.data) setAllowed(r.data)
    })()
  }, [project])

  const forget = async (rowId: string): Promise<void> => {
    await api.commands.forget(rowId)
    if (!project) return
    const r = await api.commands.allowed(project.id)
    if (r.ok && r.data) setAllowed(r.data)
  }

  const chooseFolder = async (): Promise<void> => {
    const res = await api.projects.pickRoot()
    if (res.ok && res.data) setRootPath(res.data)
  }

  // Any edit in the body marks the sheet dirty, so closing asks first; saving clears it.
  const [dirty, setDirty] = useState(false)
  const save = (): void => {
    setDirty(false)
    if (!name.trim()) return
    onSave({
      name: name.trim(),
      rootPath,
      systemPrompt,
      defaultModel: defaultModel || null,
      unlocked,
      systemAsUser,
      autoApprove,
      tiers: tiersText.trim(),
      params,
      hooks: hooks.filter((h) => h.glob.trim() && h.command.trim()),
      writeGlobs: parseFallbacks(writeGlobsText),
      contextFiles: parseFallbacks(contextFilesText)
    })
  }

  const setHook = (i: number, patch: Partial<Hook>): void =>
    setHooks((list) => list.map((h, j) => (j === i ? { ...h, ...patch } : h)))

  return (
    <Sheet
      title={project ? 'Project settings' : 'New project'}
      aside={project && <span className="sounding">{formatCost(spend) || 'no spend yet'}</span>}
      dirty={dirty}
      discardPrompt="Close without saving? The changes to this project will be lost."
      onClose={onClose}
    >
        <div className="sheet__body" onChange={() => setDirty(true)}>
          <label className="field">
            <span className="field__label">Name</span>
            <input
              className="input"
              autoFocus
              value={name}
              placeholder="harbor-ai"
              onChange={(e) => setName(e.target.value)}
            />
          </label>

          <div className="field">
            <span className="field__label">Folder</span>
            <div className="row-of">
              <button className="btn" onClick={() => void chooseFolder()}>
                <span className="row-of row-of--inline">
                  <Folder size={13} />
                  Choose folder
                </span>
              </button>
              {rootPath && (
                <button className="btn" onClick={() => setRootPath(null)}>
                  Clear
                </button>
              )}
            </div>
            <span className="field__hint">
              {rootPath ? (
                <code style={{ fontFamily: 'var(--font-mono)' }}>{rootPath}</code>
              ) : (
                'No folder yet. From Phase 3 this is the boundary the agent works inside — it cannot read or write outside it.'
              )}
            </span>
          </div>

          <label className="field">
            <span className="field__label">System prompt</span>
            <textarea
              className="input"
              rows={5}
              value={systemPrompt}
              placeholder="Standing instructions for every conversation in this project."
              onChange={(e) => setSystemPrompt(e.target.value)}
              style={{ resize: 'vertical', lineHeight: 1.55 }}
            />
          </label>

          <label className="field" style={{ display: 'block' }}>
            <span className="field__label">Commands</span>
            <label className="row-of row-of--top">
              <input
                type="checkbox"
                checked={autoApprove}
                onChange={(e) => setAutoApprove(e.target.checked)}
                className="check"
              />
              <span className="dim">
                Run commands without asking. The agent acts on its own in this project; the hard deny list still
                refuses the dangerous ones, and this only holds while the folder is under version control.
              </span>
            </label>
            <span className="field__hint">
              {rootPath
                ? isRepo === null
                  ? 'Checking whether the folder is a git repository…'
                  : isRepo
                    ? 'The folder is under git, so a bad command is a revert rather than a loss.'
                    : 'The folder is not under git. With this on, the agent will still be asked, until it is.'
                : 'Needs a folder.'}
            </span>
          </label>

          <label className="field" style={{ display: 'block' }}>
            <span className="field__label">Instructions as a user message</span>
            <label className="row-of row-of--top">
              <input
                type="checkbox"
                checked={systemAsUser}
                onChange={(e) => setSystemAsUser(e.target.checked)}
                className="check"
              />
              <span className="dim">
                Fold everything above into the first user turn instead of sending it as a
                system message.
              </span>
            </label>
            <span className="field__hint">
              A handful of models behave better this way — the original DeepSeek R1 asked
              for it, though R1-0528 no longer does. Leave it off unless a model is
              ignoring its instructions.
            </span>
          </label>

          <label className="field">
            <span className="field__label">Default model</span>
            <select
              className="input input--mono"
              value={defaultModel}
              onChange={(e) => setDefaultModel(e.target.value)}
            >
              <option value="">Whatever was used last</option>
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {shortModel(m.id)}
                </option>
              ))}
            </select>
          </label>

          {project && (
            <div className="field">
              <span className="field__label">Defaults for this project</span>
              <span className="field__hint" style={{ marginTop: 0, marginBottom: 10, display: 'block' }}>
                Any conversation can override these. Only what the default model supports
                is shown.
              </span>
              <Parameters
                model={models.find((m) => m.id === defaultModel) ?? null}
                effective={params}
                own={params}
                inheritLabel="unset"
                onChange={setParams}
              />
            </div>
          )}

          {project && (
            <div className="field">
              <span className="field__label">Off-limits paths</span>
              <span className="field__hint" style={{ marginTop: 0, marginBottom: 8, display: 'block' }}>
                The agent cannot read or write these. Open one only if the work genuinely
                needs it — unlocking never lets it outside the project folder.
              </span>
              <div className="locks">
                {LOCKS.map((lock) => (
                  <label className="locks__row" key={lock.key}>
                    <input
                      type="checkbox"
                      checked={unlocked.includes(lock.key)}
                      onChange={(e) =>
                        setUnlocked((list) =>
                          e.target.checked
                            ? [...list, lock.key]
                            : list.filter((k) => k !== lock.key)
                        )
                      }
                    />
                    <code className="locks__paths">{lock.paths}</code>
                    <span className="locks__why">{lock.why}</span>
                  </label>
                ))}
              </div>
            </div>
          )}

          {rootPath && (
            <div className="field">
              <span className="field__label">After the agent writes a file</span>
              <span className="field__hint" style={{ marginBottom: 8, display: 'block' }}>
                Commands run in the project folder when a written file matches the pattern,
                with {'{path}'} standing for the file. What they print goes back to the model
                with the write, so a typecheck here means it fixes its own errors before you
                see them.
              </span>
              {hooks.length > 0 && (
                <div className="hooks">
                  {hooks.map((h, i) => (
                    <div className="hooks__row" key={i}>
                      <input
                        className="input input--mono hooks__glob"
                        placeholder="*.ts"
                        value={h.glob}
                        onChange={(e) => setHook(i, { glob: e.target.value })}
                      />
                      <input
                        className="input input--mono hooks__cmd"
                        placeholder="npx tsc --noEmit"
                        value={h.command}
                        onChange={(e) => setHook(i, { command: e.target.value })}
                      />
                      <button
                        className="allowlist__forget"
                        onClick={() => setHooks((list) => list.filter((_, j) => j !== i))}
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <button
                className="btn"
                style={{ marginTop: hooks.length ? 8 : 0 }}
                onClick={() => setHooks((list) => [...list, { glob: '', command: '' }])}
              >
                Add a hook
              </button>
            </div>
          )}

          {rootPath && (
            <label className="field">
              <span className="field__label">Where the agent may write</span>
              <textarea
                className="input input--mono"
                rows={3}
                value={writeGlobsText}
                placeholder={'empty means anywhere in the folder, e.g.\nsrc/**\ndocs/**'}
                onChange={(e) => setWriteGlobsText(e.target.value)}
                style={{ resize: 'vertical', lineHeight: 1.55 }}
              />
              <span className="field__hint">
                Globs relative to the folder, one per line. A write anywhere else is refused and
                the agent is told where it may write instead. Reads are unaffected.
              </span>
            </label>
          )}

          {rootPath && (
            <label className="field">
              <span className="field__label">Files read into every prompt</span>
              <textarea
                className="input input--mono"
                rows={2}
                value={contextFilesText}
                placeholder={'paths relative to the folder, one per line, e.g.\nnotes/lessons.md'}
                onChange={(e) => setContextFilesText(e.target.value)}
                style={{ resize: 'vertical', lineHeight: 1.55 }}
              />
              <span className="field__hint">
                What the project has learned, kept in files the agent maintains with your agreement
                and read fresh each turn. A file that does not exist yet is skipped; the prompt
                inspector shows each one that does.
              </span>
            </label>
          )}

          <label className="field">
            <span className="field__label">Model tiers</span>
            <textarea
              className="input input--mono"
              rows={5}
              value={tiersText}
              placeholder={formatTiers(DEFAULT_TIERS)}
              onChange={(e) => setTiersText(e.target.value)}
              style={{ resize: 'vertical', lineHeight: 1.55 }}
            />
            <span className="field__hint">
              One per line, as name = model | what it is for. A director picks a tier for each task and the tier
              names the model, so a rename goes to something quick and a change that has to be right goes
              to something deep. A tier with no model uses the conversation's own. The director tier needs a
              million tokens of context. Two tiers are for phases rather than tasks: plan, the model a plan-mode
              turn runs on; and oracle, a stronger model the agent may ask for a second opinion.
              {(() => {
                const known = new Set(models.map((m) => m.id))
                const unknown = parseTiers(tiersText).filter((t) => t.model && models.length > 0 && !known.has(t.model))
                return unknown.length ? ` Not in the model list: ${unknown.map((t) => t.model).join(', ')}.` : ''
              })()}
            </span>
          </label>

          {project && (
            <div className="field">
              <span className="field__label">Commands allowed without asking</span>
              {allowed.length === 0 ? (
                <span className="field__hint">
                  Nothing yet. Choosing “Always allow” on an approval adds it here, and it
                  applies to this project only.
                </span>
              ) : (
                <div className="allowlist">
                  {allowed.map((a) => (
                    <div className="allowlist__row" key={a.id}>
                      <code className="allowlist__pattern">{a.pattern}</code>
                      <button className="allowlist__forget" onClick={() => void forget(a.id)}>
                        Forget
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="row-of">
            <button className="btn btn--primary" disabled={!name.trim()} onClick={save}>
              {project ? 'Save' : 'Create project'}
            </button>

            {onDelete &&
              (confirming ? (
                <>
                  <span className="sounding">Deletes every conversation in it.</span>
                  <button className="btn btn--danger" onClick={onDelete}>
                    Delete anyway
                  </button>
                  <button className="btn" onClick={() => setConfirming(false)}>
                    Keep
                  </button>
                </>
              ) : (
                <button className="btn btn--danger" onClick={() => setConfirming(true)}>
                  Delete project
                </button>
              ))}
          </div>
        </div>
    </Sheet>
  )
}
