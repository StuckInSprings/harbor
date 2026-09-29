import { Menu, dialog, type BrowserWindow, type MenuItemConstructorOptions } from 'electron'

/**
 * Right-click menus.
 *
 * These are real macOS menus rather than HTML imitations, because that is what
 * a right-click is supposed to produce — correct keyboard handling, correct
 * placement near the screen edge, and the system's own appearance.
 *
 * The renderer asks for a menu and gets back the chosen action, or null if the
 * menu was dismissed. Destructive choices confirm through a native dialog
 * before they resolve.
 */

export interface MenuRequest {
  kind: 'conversation' | 'project' | 'message' | 'selection'
  /** Shapes the menu: what is pinned, archived, whose message it is. */
  state?: Record<string, boolean | string | number>
}

export function itemsFor(req: MenuRequest): MenuItemConstructorOptions[] {
  const s = req.state ?? {}

  if (req.kind === 'conversation') {
    return [
      { id: 'rename', label: 'Rename' },
      { id: 'pin', label: s.pinned ? 'Unpin' : 'Pin' },
      { id: 'archive', label: s.archived ? 'Move back to the sidebar' : 'Archive' },
      { type: 'separator' },
      { id: 'delete', label: 'Delete…' }
    ]
  }

  if (req.kind === 'selection') {
    const n = Number(s.count ?? 0)
    const noun = `${n} conversation${n === 1 ? '' : 's'}`
    return [
      { id: 'archive', label: `Archive ${noun}` },
      { id: 'unarchive', label: `Move ${noun} back to the sidebar`, visible: s.anyArchived === true },
      { type: 'separator' },
      { id: 'delete', label: `Delete ${noun}…` },
      { type: 'separator' },
      { id: 'clear', label: 'Clear selection' }
    ]
  }

  if (req.kind === 'project') {
    return [
      { id: 'new', label: 'New conversation' },
      { id: 'interview', label: 'Interview for a director run…' },
      { id: 'search', label: 'Search everything' },
      { type: 'separator' },
      { id: 'toggleArchived', label: s.showingArchived ? 'Hide archived' : 'Show archived' },
      { id: 'settings', label: 'Project settings' },
      { type: 'separator' },
      { id: 'moveUp', label: 'Move up', enabled: s.first !== true },
      { id: 'moveDown', label: 'Move down', enabled: s.last !== true },
      { id: 'archive', label: s.archived ? 'Unarchive project' : 'Archive project', enabled: s.archivable === true },
      { type: 'separator' },
      { id: 'delete', label: 'Delete project…', enabled: s.deletable === true }
    ]
  }

  const isAssistant = s.role === 'assistant'
  return [
    { id: 'copy', label: 'Copy' },
    ...(isAssistant
      ? ([
          { id: 'retry', label: 'Retry' },
          { id: 'remember', label: 'Remember this' }
        ] as MenuItemConstructorOptions[])
      : ([{ id: 'edit', label: 'Edit and fork' }] as MenuItemConstructorOptions[])),
    { type: 'separator' },
    { id: 'delete', label: 'Delete' }
  ]
}

const CONFIRM: Record<string, { message: string; detail: string; ok: string }> = {
  'conversation:delete': {
    message: 'Delete this conversation?',
    detail: 'Every message and branch in it goes too. This cannot be undone.',
    ok: 'Delete'
  },
  'project:delete': {
    message: 'Delete this project?',
    detail:
      'Its conversations, memories and knowledge index go with it. Files on disk are left alone. This cannot be undone.',
    ok: 'Delete'
  }
}

export function show(win: BrowserWindow, req: MenuRequest): Promise<string | null> {
  return new Promise((resolve) => {
    let chosen: string | null = null

    const template = itemsFor(req).map((item) =>
      item.type === 'separator'
        ? item
        : { ...item, click: () => (chosen = String(item.id)) }
    )

    Menu.buildFromTemplate(template).popup({
      window: win,
      callback: () => {
        // Fires after the click handler, so `chosen` is settled by now.
        void (async () => {
          if (!chosen) return resolve(null)
          const confirm = CONFIRM[`${req.kind}:${chosen}`]
          if (!confirm) return resolve(chosen)

          const { response } = await dialog.showMessageBox(win, {
            type: 'warning',
            buttons: ['Cancel', confirm.ok],
            defaultId: 0,
            cancelId: 0,
            message: confirm.message,
            detail: confirm.detail
          })
          resolve(response === 1 ? chosen : null)
        })()
      }
    })
  })
}
