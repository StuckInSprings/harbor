import { dialog, shell } from 'electron'
import * as db from '../db'
import * as keychain from '../keychain'
import * as or from '../openrouter'
import * as menus from '../menus'
import * as log from '../log'
import * as sandbox from '../sandbox'
import * as mcp from '../mcp'
import * as bridge from '../bridge'
import { ANSWERS_SETTING, CAP_SETTING, ENABLED_SETTING, PORT_SETTING, parseCap, parsePort, type SuggestionState } from '../../../shared/bridge'
import type { MenuRequest } from '../menus'
import { handle, broadcast, type Ipc } from './shared'

/**
 * The application itself: the key, the model catalogue, settings, the log,
 * native menus and dialogs, external links, the second window.
 */
export function register(ipc: Ipc): void {
  const win = ipc.win
  handle('ui:popOut', (conversationId: string) => {
    ipc.popOut(conversationId)
    return true
  })
  handle('ui:isPoppedOut', (conversationId: string) => ipc.isPoppedOut(conversationId))
  /* key */
  handle('key:status', async () => {
    if (!keychain.hasKey()) return { present: false }
    try {
      return { present: true, ...(await or.fetchKeyInfo()) }
    } catch {
      // A stored-but-unverifiable key is still stored; say so rather than lying.
      return { present: true }
    }
  })
  handle('key:set', (plain: string) => {
    keychain.setKey(plain)
    return true
  })
  handle('key:clear', () => {
    keychain.clearKey()
    return true
  })

  /* models */
  handle('models:list', () => or.fetchModels())
  handle('models:favorites', () => db.listFavorites())
  handle('models:toggleFavorite', (modelId: string) => db.toggleFavorite(modelId))

  /* context menus */
  handle('menu:show', (req: MenuRequest) => menus.show(win, req))
  /* A yes-or-no the renderer needs before something irreversible; the native sheet, not a div. */
  handle('dialog:confirm', async (message: string, detail: string, ok: string) => {
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['Cancel', ok],
      defaultId: 0,
      cancelId: 0,
      message,
      detail
    })
    return response === 1
  })

  /* diagnostics */
  handle('log:recent', () => log.recent())
  handle('log:path', () => log.logPath())
  handle('log:reveal', () => {
    log.reveal()
    return true
  })
  handle('log:write', (level: 'info' | 'warn' | 'error', scope: string, message: string) => {
    log.log(level, scope, message)
    return true
  })
  // The interface tails the log live, which is the point when something hangs.
  log.onLine((line) => {
    broadcast('log:line', line)
  })

  /* search and prompts */
  handle('search:all', (query: string) => db.searchEverything(query))
  handle('prompts:list', (projectId: string | null) => db.listPrompts(projectId))
  handle(
    'prompts:save',
    (promptId: string | null, projectId: string | null, name: string, body: string) =>
      db.savePrompt(promptId, projectId, name, body)
  )
  handle('prompts:delete', (promptId: string) => {
    db.removePrompt(promptId)
    return true
  })

  /* settings */
  handle('settings:get', (key: string) => db.getSetting(key))
  handle('settings:set', (key: string, value: string) => {
    db.setSetting(key, value)
    if (key.startsWith('sandbox_')) void sandbox.reconfigure()
    if (key === 'mcp_servers') void mcp.init()
    return true
  })
  /* MCP servers: what is connected, and a way to try again. */
  handle('mcp:status', () => ({ servers: mcp.status(), error: mcp.configured().error ?? null }))
  handle('mcp:reconnect', async () => {
    await mcp.init()
    return { servers: mcp.status(), error: mcp.configured().error ?? null }
  })

  /* The bridge: Harbor as an MCP server Claude Code drives director runs through. */
  handle('bridge:status', () => bridge.status())
  handle('bridge:configure', async (change: { enabled?: boolean; port?: number; cap?: number; answers?: boolean }) => {
    if (change.enabled !== undefined) db.setSetting(ENABLED_SETTING, change.enabled ? '1' : '0')
    if (change.answers !== undefined) db.setSetting(ANSWERS_SETTING, change.answers ? '1' : '0')
    if (change.port !== undefined) db.setSetting(PORT_SETTING, String(parsePort(String(change.port))))
    if (change.cap !== undefined) db.setSetting(CAP_SETTING, String(parseCap(String(change.cap))))
    log.info('bridge', 'settings changed', change)
    if (change.enabled !== undefined || change.port !== undefined) await bridge.init()
    return bridge.status()
  })
  /* Claude's reviews of a run, and what the person did with each suggestion. */
  handle('reviews:list', (conversationId: string) => db.listReviews(conversationId))
  handle('reviews:setState', (reviewId: string, index: number, state: SuggestionState) => {
    if (!['open', 'sent', 'dismissed'].includes(state)) throw new Error('Not a suggestion state.')
    return db.setSuggestionState(reviewId, Number(index), state)
  })
  handle('bridge:newToken', () => {
    bridge.newToken()
    return bridge.status()
  })

  /* shell — only ever opens external https links the user clicked */
  handle('shell:openExternal', (url: string) => {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:') throw new Error('Only https links open externally.')
    void shell.openExternal(url)
    return true
  })
}
