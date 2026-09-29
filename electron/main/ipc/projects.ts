import { dialog } from 'electron'
import * as db from '../db'
import * as workspace from '../workspace'
import { handle, type Ipc } from './shared'

/**
 * Projects and what they have cost.
 */
export function register(ipc: Ipc): void {
  const win = ipc.win
  /* projects */
  handle('projects:list', () => db.listProjects())
  handle('projects:isRepo', (path: string) => workspace.isRepo(path))
  handle('projects:create', (name: string, rootPath: string | null) =>
    db.createProject(name, rootPath)
  )
  handle('projects:update', (id: string, patch: any) => {
    db.updateProject(id, patch)
    return true
  })
  handle('projects:setArchived', (id: string, archived: boolean) => {
    db.setProjectArchived(id, !!archived)
    return true
  })
  handle('projects:reorder', (ids: string[]) => {
    db.reorderProjects(Array.isArray(ids) ? ids.map(String) : [])
    return true
  })
  handle('projects:delete', (id: string) => {
    db.deleteProject(id)
    return true
  })
  handle('projects:pickRoot', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Choose a project folder',
      properties: ['openDirectory', 'createDirectory']
    })
    return r.canceled ? null : (r.filePaths[0] ?? null)
  })

}
