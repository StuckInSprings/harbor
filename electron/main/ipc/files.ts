import { dialog } from 'electron'
import { randomUUID } from 'node:crypto'
import * as db from '../db'
import * as checkpoints from '../checkpoints'
import * as shadow from '../shadow'
import * as workspace from '../workspace'
import * as attach from '../attachments'
import * as blobs from '../blobs'
import { handle, contextFor, type Ipc } from './shared'

/**
 * The project folder as the renderer sees it: checkpoints and the ways back
 * through them, the Files pane, attachments from disk and from the project.
 */
export function register(ipc: Ipc): void {
  const win = ipc.win
  /* attachments */
  handle('attachments:pick', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Attach files',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Attachable', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'pdf', 'txt', 'md', 'csv', 'json', 'ts', 'js', 'py'] }
      ]
    })
    if (r.canceled) return []
    const out = []
    for (const path of r.filePaths) out.push(await attach.ingest(path))
    return out
  })
  handle(
    'attachments:ingestData',
    (name: string, mime: string, base64: string) =>
      attach.ingestBytes(name, mime, Buffer.from(base64, 'base64'))
  )
  handle('attachments:read', async (hash: string) => {
    const data = await blobs.getBuffer(hash)
    return data ? data.toString('base64') : null
  })

  /* checkpoints — the undo story for auto-applied edits */
  handle('checkpoints:list', (conversationId: string) =>
    db.listConversationCheckpoints(conversationId)
  )
  handle('checkpoints:diff', async (checkpointId: string) => {
    const cp = db.getCheckpoint(checkpointId)
    if (!cp) throw new Error('That change is no longer on file.')
    return {
      path: cp.path,
      before: await checkpoints.getBlob(cp.beforeHash),
      after: await checkpoints.getBlob(cp.afterHash)
    }
  })
  /*
    Undoing changes the disk but not the transcript, and the model would carry
    on believing its edit stands. Record the revert in the conversation so the
    next turn sees the world as it now is.
  */
  const noteRevert = (conversationId: string, text: string): void => {
    const conv = db.getConversation(conversationId)
    db.addMessage(conversationId, conv?.leafId ?? null, 'system', text, null)
  }

  /* A file's versions across the project, and ways back to any of them. */
  handle('checkpoints:history', (conversationId: string, path: string) => {
    const conv = db.getConversation(conversationId)
    if (!conv) throw new Error('That conversation is gone.')
    return db.listPathCheckpoints(conv.projectId, path)
  })
  handle('checkpoints:blob', (hash: string) => checkpoints.getBlob(hash))
  handle('checkpoints:restore', async (conversationId: string, path: string, hash: string) => {
    const content = await checkpoints.getBlob(hash)
    if (content === null) throw new Error('That version is no longer on file.')
    const { root, unlocked } = contextFor(conversationId)
    // Itself a checkpointed write, so restoring is one more step in the history, never a hole.
    await checkpoints.writeWithCheckpoint(root, `restore-${randomUUID()}`, conversationId, path, content, unlocked)
    noteRevert(conversationId, `Restored an earlier version of ${path}.`)
    return true
  })
  handle('checkpoints:saveAs', async (conversationId: string, path: string, hash: string, newPath: string) => {
    const content = await checkpoints.getBlob(hash)
    if (content === null) throw new Error('That version is no longer on file.')
    const { root, unlocked } = contextFor(conversationId)
    await checkpoints.writeWithCheckpoint(root, `fork-${randomUUID()}`, conversationId, newPath, content, unlocked)
    noteRevert(conversationId, `Saved a version of ${path} as ${newPath}.`)
    return true
  })

  /*
    The whole tree, either side of each agent turn, from the shadow
    repository: what changed by any means, and a restore to any of them.
  */
  handle('snapshots:list', (conversationId: string) => db.listSnapshots(conversationId))
  handle('snapshots:changes', async (conversationId: string, fromId: string, toId: string) => {
    const { project } = contextFor(conversationId)
    const a = db.getSnapshot(fromId)
    const b = db.getSnapshot(toId)
    if (!a || !b || a.projectId !== project.id || b.projectId !== project.id) throw new Error('Those snapshots are not this project\'s.')
    return shadow.changed(project.id, project.rootPath!, a.sha, b.sha)
  })
  handle('snapshots:restore', async (conversationId: string, snapshotId: string) => {
    const { project } = contextFor(conversationId)
    const s = db.getSnapshot(snapshotId)
    if (!s || s.projectId !== project.id) throw new Error('That snapshot is not this project\'s.')
    const safety = await shadow.restore(project.id, project.rootPath!, s.sha)
    if (safety) db.addSnapshot({ runId: `restore-${randomUUID()}`, conversationId, projectId: project.id, kind: 'restore', sha: safety })
    noteRevert(conversationId, `The whole project tree was put back as it was ${s.kind === 'before' ? 'before' : s.kind === 'after' ? 'after' : 'at'} the turn of ${new Date(s.createdAt).toLocaleString()}. Every file is as it was then, whatever changed it.`)
    return true
  })

  handle('checkpoints:undo', async (conversationId: string, checkpointId: string) => {
    const cp = db.getCheckpoint(checkpointId)
    const { root, unlocked, project } = contextFor(conversationId)
    // The checkpoint's own project, or a change from one project would be undone into another's tree.
    if (cp && db.getConversation(cp.conversationId)?.projectId !== project.id) throw new Error('That change belongs to another project.')
    await checkpoints.undo(root, checkpointId, unlocked)
    if (cp) {
      noteRevert(
        conversationId,
        cp.created
          ? `${cp.path} was deleted again, undoing the edit that created it.`
          : `${cp.path} was reverted to its previous contents. The edit no longer stands.`
      )
    }
    return true
  })
  handle('checkpoints:revertRun', async (conversationId: string, runId: string) => {
    const cps = db.listCheckpoints(runId)
    const paths = cps.filter((c) => !c.undone).map((c) => c.path)
    const { root, unlocked, project } = contextFor(conversationId)
    if (cps.some((c) => db.getConversation(c.conversationId)?.projectId !== project.id)) throw new Error('That run belongs to another project.')
    const n = await checkpoints.revertRun(root, runId, unlocked)
    if (n > 0) {
      noteRevert(
        conversationId,
        `Reverted ${n} ${n === 1 ? 'file' : 'files'} from an earlier step: ${paths.join(', ')}. Those edits no longer stand.`
      )
    }
    return n
  })

  /* workspace — read-only, for the Files pane */
  handle('workspace:read', async (conversationId: string, path: string) => {
    const { root, unlocked } = contextFor(conversationId)
    const content = await workspace.readRaw(root, path, unlocked)
    if (content === null) throw new Error(`${path} could not be read.`)
    return content
  })
  handle('workspace:list', (conversationId: string, path: string) => {
    const { root, unlocked } = contextFor(conversationId)
    return workspace.listDir(root, path, unlocked)
  })
  /*
    A save from the editor. Checkpointed like an agent write, so it appears in
    Changes and in the file's history with the conversation it was made in —
    but hooks do not run: they are for what the agent writes, and their output
    would have no reader here.
  */
  handle('workspace:write', async (conversationId: string, path: string, content: string) => {
    const { root, unlocked } = contextFor(conversationId)
    await checkpoints.writeWithCheckpoint(root, `edit-${randomUUID()}`, conversationId, path, content, unlocked)
    return true
  })
  handle('workspace:tree', (conversationId: string, path: string) => {
    const { root, unlocked } = contextFor(conversationId)
    return workspace.tree(root, path, unlocked)
  })
  handle('workspace:readImage', (conversationId: string, path: string) => {
    const { root, unlocked } = contextFor(conversationId)
    return workspace.readImage(root, path, unlocked)
  })
  /* A project file into the composer, through the same jail as everything else. */
  handle('attachments:fromProject', async (conversationId: string, path: string) => {
    const { root, unlocked } = contextFor(conversationId)
    const abs = await workspace.resolveInside(root, path, unlocked)
    return attach.ingest(abs)
  })

}
