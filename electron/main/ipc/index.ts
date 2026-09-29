import type { BrowserWindow } from 'electron'
import type { Ipc } from './shared'
import * as app from './app'
import * as projects from './projects'
import * as conversations from './conversations'
import * as context from './context'
import * as turns from './turns'
import * as files from './files'
import * as director from './director'

/**
 * The renderer's capability surface, one file per domain. Each registers its
 * own channels; preload/index.ts is the other half of the same list.
 */
export function registerIpc(win: BrowserWindow, extra: { popOut: (conversationId: string) => void; isPoppedOut: (conversationId: string) => boolean }): void {
  const ipc: Ipc = { win, popOut: extra.popOut, isPoppedOut: extra.isPoppedOut }
  for (const domain of [app, projects, conversations, context, turns, files, director]) domain.register(ipc)
}
