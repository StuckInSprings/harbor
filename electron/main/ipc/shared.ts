import { ipcMain, BrowserWindow } from 'electron'
import type { Result, Unlockable, Project } from '../../../shared/types'
import * as db from '../db'
import * as worktrees from '../worktrees'

/**
 * What every domain's handlers share: the wrapper that turns a throw into
 * {ok:false}, the broadcast to every window, and the one guard a handler
 * that takes a conversation and a path goes through.
 */

export interface Ipc {
  win: BrowserWindow
  popOut: (conversationId: string) => void
  isPoppedOut: (conversationId: string) => boolean
}

/** Wraps a handler so the renderer always gets {ok, data|error} rather than a rejection. */
export function handle<T>(channel: string, fn: (...args: any[]) => T | Promise<T>): void {
  ipcMain.handle(channel, async (_e, ...args): Promise<Result<T>> => {
    try {
      return { ok: true, data: await fn(...args) }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })
}

/** Every window shows conversations, so what happens in a turn is sent to all of them; the main window alone is told where to go. */
export const broadcast = (channel: string, payload: unknown): void => {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(channel, payload)
}

/** The project a conversation belongs to, with its folder: the jail's root for anything the renderer asks to read or write there. */
export const contextFor = (conversationId: string): { root: string; unlocked: Unlockable[]; project: Project } => {
  const conv = db.getConversation(conversationId)
  const project = conv ? db.getProject(conv.projectId) : null
  if (!project?.rootPath) throw new Error('That project has no folder set.')
  // A worker out in a worktree reads and writes there, not the project's own tree.
  return { root: worktrees.rootOverride(conversationId) ?? project.rootPath, unlocked: project.unlocked, project }
}
export const rootFor = (conversationId: string): string => contextFor(conversationId).root
