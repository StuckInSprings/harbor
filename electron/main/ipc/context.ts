import { dialog } from 'electron'
import * as db from '../db'
import * as skills from '../skills'
import * as knowledge from '../knowledge'
import { assembleSystem } from '../context'
import { handle, broadcast, type Ipc } from './shared'

/**
 * The three context channels — skills, knowledge, memory — and the prompt inspector.
 */
export function register(ipc: Ipc): void {
  const win = ipc.win
  /*
    Indexing is slow the first time — the embedding model has to be fetched —
    so it runs detached and reports progress rather than blocking a call.
  */
  const indexInBackground = async (
    sourceId: string,
    projectId: string,
    path: string
  ): Promise<void> => {
    const send = (payload: unknown): void => {
      broadcast('knowledge:progress', payload)
    }
    try {
      send({ sourceId, state: 'indexing', file: '', done: 0, total: 0 })
      const result = await knowledge.indexSource(sourceId, projectId, path, (p) =>
        send({ sourceId, state: 'indexing', ...p })
      )
      send({ sourceId, state: 'done', ...result })
    } catch (e) {
      send({ sourceId, state: 'error', message: (e as Error).message })
    }
  }

  /* context channels — skills, knowledge, memory */

  handle('skills:list', (projectId: string | null) => skills.list(projectId))
  handle(
    'skills:save',
    (projectId: string | null, name: string, description: string, body: string) =>
      skills.save(projectId, name, description, body)
  )
  handle('skills:delete', async (projectId: string | null, name: string) => {
    await skills.remove(projectId, name)
    return true
  })

  handle('knowledge:sources', (projectId: string) => db.listSources(projectId))
  handle('knowledge:pick', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Add reference material',
      properties: ['openFile', 'openDirectory', 'multiSelections']
    })
    return r.canceled ? [] : r.filePaths
  })
  handle('knowledge:add', async (projectId: string, path: string) => {
    const source = db.addSource(projectId, path)
    void indexInBackground(source.id, projectId, path)
    return source
  })
  handle('knowledge:reindex', async (sourceId: string, projectId: string, path: string) => {
    void indexInBackground(sourceId, projectId, path)
    return true
  })
  handle('knowledge:remove', (sourceId: string) => {
    db.removeSource(sourceId)
    return true
  })
  handle('knowledge:vectorSearch', () => db.hasVectorSearch())

  handle('memory:list', (projectId: string) => db.listMemories(projectId))
  handle('memory:add', (projectId: string, text: string) =>
    db.addMemory({
      projectId,
      text,
      sourceConvId: null,
      sourceMsgId: null,
      extractedBy: null,
      origin: 'person',
      reviewed: true
    })
  )
  /* The person's verdict on a memory that waited: kept, or dropped. */
  handle('memory:review', (memId: string, keep: boolean) => {
    db.reviewMemory(memId, keep)
    return true
  })
  handle('memory:setEnabled', (memId: string, enabled: boolean) => {
    db.setMemoryEnabled(memId, enabled)
    return true
  })
  handle('memory:setPinned', (memId: string, pinned: boolean) => {
    db.setMemoryPinned(memId, pinned)
    return true
  })
  handle('memory:remove', (memId: string) => {
    db.removeMemory(memId)
    return true
  })

  /*
    The prompt inspector. Same assembly path the turn uses, so what is shown is
    what is sent rather than a re-derivation that can drift.
  */
  handle(
    'context:system',
    (projectId: string | null, model: string, web: boolean, plan: boolean) =>
      assembleSystem({ projectId, model, web, plan })
  )

}
