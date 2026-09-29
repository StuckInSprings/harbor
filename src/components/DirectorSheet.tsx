import { useEffect, useMemo, useState } from 'react'
import type { ModelInfo, Project } from '../../shared/types'
import { DIRECTOR_CONTEXT_MIN, DIRECTOR_TIER, parseTiers, tierModel } from '../../shared/tiers'
import { Sheet } from './Sheet'
import { api } from '../lib/api'

/**
 * Starting a director: which model plans, and how much the run may spend.
 * The model comes from the project's director tier when it names one; the
 * sheet says how much context it has, since a director with less than a
 * million tokens will lose the plan before the run is over.
 */
export function DirectorSheet({
  project,
  models,
  currentModel,
  requirements,
  fromInterview,
  onStart,
  onClose
}: {
  project: Project
  models: ModelInfo[]
  currentModel: string
  /** This run's requirements file: the interview's, in the run's own folder. */
  requirements: string
  fromInterview: boolean
  onStart: (model: string, budget: number, rehearsal: boolean) => Promise<void>
  onClose: () => void
}): React.JSX.Element {
  const tiers = useMemo(() => parseTiers(project.tiers), [project.tiers])
  const [model, setModel] = useState(() => tierModel(tiers, DIRECTOR_TIER, currentModel))
  const [budget, setBudget] = useState('5')
  const [rehearsal, setRehearsal] = useState(false)
  const [busy, setBusy] = useState(false)
  // Workers do not ask before running commands, and that holds only inside a repository; outside one they would stall.
  const [repo, setRepo] = useState<boolean | null>(null)
  useEffect(() => {
    // No folder is answered at once; the check would otherwise be waited on for ever.
    if (!project.rootPath) {
      setRepo(false)
      return
    }
    void api.projects.isRepo(project.rootPath).then((r) => setRepo(r.ok ? (r.data ?? false) : false))
  }, [project.rootPath])
  const info = models.find((m) => m.id === model) ?? null
  const context = info?.contextLength ?? 0
  const small = context > 0 && context < DIRECTOR_CONTEXT_MIN
  const amount = Number(budget)
  const ok = !!model.trim() && Number.isFinite(amount) && amount >= 0 && repo === true

  return (
    <Sheet title="Start a director" aside={<span className="sounding">{project.name}</span>} onClose={onClose}>
        <div className="sheet__body">
          <p className="tabs__blurb">
            {fromInterview
              ? <>The director reads <code>{requirements}</code>, the requirements this interview wrote, and no other run's. It writes a design and a task board beside them in the same folder, and stops for your approval.</>
              : <>This director has no interview, so it gets a run folder of its own with no requirements in it, and will stop and say so. Start it from an interview's header instead.</>}
            After that it briefs workers in their own conversations and judges what they return, until the work is
            done or the money is.
          </p>

          <label className="field">
            <span className="field__label">Model that directs</span>
            <input
              className="input input--mono"
              list="director-models"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="provider/model"
            />
            <datalist id="director-models">
              {models
                .filter((m) => m.contextLength >= DIRECTOR_CONTEXT_MIN)
                .map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
            </datalist>
            <span className="field__hint" style={small ? { color: 'var(--cardinal)' } : undefined}>
              {info
                ? small
                  ? `${info.name} has ${Math.round(context / 1000)}k tokens of context. A director needs ${DIRECTOR_CONTEXT_MIN / 1_000_000} million; it will lose the plan mid-run. Pick another, or set the director tier in the project settings.`
                  : `${info.name}: ${Math.round(context / 1_000_000 * 10) / 10}M tokens of context. Enough.`
                : model.trim()
                  ? 'Not in the model list, so its context length is unknown.'
                  : 'The project names no director tier; choose a model with at least a million tokens of context.'}
            </span>
          </label>

          <label className="field">
            <span className="field__label">Budget, in dollars</span>
            <input
              className="input input--mono"
              value={budget}
              inputMode="decimal"
              onChange={(e) => setBudget(e.target.value)}
              style={{ maxWidth: 140 }}
            />
            <span className="field__hint">
              The ceiling for the whole run: the director's own turns and every worker's. Workers stop at ninety
              percent; the rest is the director's, for the handoff. Zero means no ceiling.
            </span>
          </label>

          <label className="field field--row row-of row-of--top">
            <input type="checkbox" checked={rehearsal} onChange={(e) => setRehearsal(e.target.checked)} className="check" />
            <span className="dim">
              Rehearse one task first. The director plans and runs a single task end to end, then stops, so the mechanics
              are proven on this folder before the whole run is paid for. A dollar is usually enough for it.
            </span>
          </label>

          <p className="field__hint" style={repo === false ? { color: 'var(--cardinal)' } : undefined}>
            {repo === null
              ? 'Checking whether the folder is under git…'
              : repo
                ? 'The folder is under git. If it is the repository itself and clean, the run gets a branch of its own; otherwise the run records the commit it starts from.'
                : !project.rootPath
                  ? 'This project has no folder, so a run has nowhere to work. Set one in the project settings.'
                  : 'The folder is not under git. Workers run commands without asking, and that holds only inside a repository; put the folder under git first.'}
          </p>

          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button className="btn" onClick={onClose}>
              Cancel
            </button>
            <button
              className="btn btn--primary"
              disabled={!ok || busy}
              onClick={() => {
                setBusy(true)
                void onStart(model.trim(), rehearsal && amount > 1 ? 1 : amount, rehearsal).finally(() => setBusy(false))
              }}
            >
              {busy ? 'Starting…' : 'Start'}
            </button>
          </div>
        </div>
    </Sheet>
  )
}
