import * as db from '../db'
import * as log from '../log'
import * as runs from '../runs'
import { handle, type Ipc } from './shared'

/**
 * A director run as the window drives it; the work itself is in runs.ts,
 * which the bridge drives too.
 */
export function register(_ipc: Ipc): void {
  handle('conversations:startDirector', (projectId: string, model: string, budget: number, rehearsal?: boolean, fromInterview?: string | null) =>
    runs.startDirector(projectId, model, budget, rehearsal, fromInterview)
  )
  handle('conversations:setBudget', (id: string, budget: number) => {
    db.setBudget(id, Number(budget) || 0)
    log.info('director', 'budget set', { budget })
    return true
  })
  handle('conversations:approve', (id: string) => {
    db.approveConversation(id)
    return true
  })
  handle('director:finish', (id: string) => runs.finishRun(id))
  handle('director:workers', (id: string) => runs.workersOf(id))
  handle('director:status', (id: string) => runs.statusOf(id))
  handle('director:board', (id: string) => runs.boardOf(id))
}
