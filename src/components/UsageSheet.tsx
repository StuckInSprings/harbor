import { useEffect, useState } from 'react'
import type { DailyCost, Project } from '../../shared/types'
import { formatCost } from '../lib/format'
import { Sheet } from './Sheet'
import { api } from '../lib/api'

/**
 * Spend is reported exactly as OpenRouter bills it, so figures here are what
 * was actually charged rather than an estimate from token counts.
 */
export function UsageSheet({
  projects,
  onClose
}: {
  projects: Project[]
  onClose: () => void
}): React.JSX.Element {
  const [byProject, setByProject] = useState<Record<string, number>>({})
  const [daily, setDaily] = useState<DailyCost[]>([])

  useEffect(() => {
    void (async () => {
      const p = await api.usage.byProject()
      const d = await api.usage.daily(14)
      if (p.ok && p.data) setByProject(p.data)
      if (d.ok && d.data) setDaily(d.data)
    })()
  }, [])

  const total = Object.values(byProject).reduce((a, b) => a + b, 0)
  const peak = Math.max(...daily.map((d) => d.total), 0.0000001)

  return (
    <Sheet title="Usage" aside={<span className="sounding">{formatCost(total) || 'nothing yet'} all time</span>} onClose={onClose}>

        <div className="sheet__body">
          <h3 className="usage__head">By project</h3>
          {projects.length === 0 && <p className="hint">No projects yet.</p>}
          {projects.map((p) => (
            <div className="usage__row" key={p.id}>
              <span className="usage__label">{p.name}</span>
              <span className="sounding">{formatCost(byProject[p.id] ?? 0) || 'free'}</span>
            </div>
          ))}

          <h3 className="usage__head">Last 14 days</h3>
          {daily.length === 0 && (
            <p className="hint">
              No charged messages yet. Spend appears here once a model replies.
            </p>
          )}
          {daily.map((d) => (
            <div className="usage__row" key={d.day}>
              <span className="sounding" style={{ width: 78 }}>
                {d.day}
              </span>
              <span className="usage__bar">
                <span style={{ width: `${Math.max((d.total / peak) * 100, 1.5)}%` }} />
              </span>
              <span className="sounding" style={{ width: 74, textAlign: 'right' }}>
                {formatCost(d.total)}
              </span>
              <span className="sounding" style={{ width: 58, textAlign: 'right' }}>
                {d.messages} msg
              </span>
            </div>
          ))}
        </div>
    </Sheet>
  )
}
