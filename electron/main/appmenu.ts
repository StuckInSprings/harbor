import { app, BrowserWindow, Menu, type MenuItemConstructorOptions } from 'electron'

/**
 * The menu bar. Electron's default one holds Close Window and the zoom
 * items, so nothing Harbor can do was written down anywhere a person
 * could find it, and the shortcuts that existed (⌘K, ⌘N, ⌘,) were
 * folklore. Every command here goes to the window in front as one word;
 * the renderer does the rest, and a pop-out ignores what is not its own.
 */

export type Command =
  | 'new'
  | 'ask'
  | 'plan'
  | 'new-project'
  | 'search'
  | 'settings'
  | 'sidebar'
  | 'terminal'
  | 'changes'
  | 'explorer'
  | 'context'
  | 'usage'
  | 'log'
  | 'compact'

const send = (command: Command): void => {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
  if (win && !win.isDestroyed()) win.webContents.send('ui:command', command)
}

const item = (label: string, command: Command, accelerator?: string): MenuItemConstructorOptions => ({
  label,
  ...(accelerator ? { accelerator } : {}),
  click: () => send(command)
})

export function template(opts: { dev: boolean }): MenuItemConstructorOptions[] {
  const mac = process.platform === 'darwin'
  const appMenu: MenuItemConstructorOptions = {
    label: app.name,
    submenu: [
      { role: 'about', label: 'About Harbor' },
      { type: 'separator' },
      item('Settings…', 'settings', 'CommandOrControl+,'),
      { type: 'separator' },
      { role: 'services' },
      { type: 'separator' },
      { role: 'hide', label: 'Hide Harbor' },
      { role: 'hideOthers' },
      { role: 'unhide' },
      { type: 'separator' },
      { role: 'quit', label: 'Quit Harbor' }
    ]
  }
  const file: MenuItemConstructorOptions = {
    label: 'File',
    submenu: [
      item('New Conversation', 'new', 'CommandOrControl+N'),
      item('Quick Question', 'ask', 'CommandOrControl+Shift+N'),
      item('Plan a Run…', 'plan'),
      { type: 'separator' },
      item('New Project…', 'new-project', 'CommandOrControl+Shift+P'),
      { type: 'separator' },
      item('Compact This Conversation', 'compact'),
      { type: 'separator' },
      { role: 'close' }
    ]
  }
  const edit: MenuItemConstructorOptions = {
    label: 'Edit',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      { role: 'pasteAndMatchStyle' },
      { role: 'selectAll' },
      { type: 'separator' },
      item('Find…', 'search', 'CommandOrControl+K')
    ]
  }
  const view: MenuItemConstructorOptions = {
    label: 'View',
    submenu: [
      item('Toggle Sidebar', 'sidebar', 'CommandOrControl+Shift+S'),
      { type: 'separator' },
      item('Terminal', 'terminal', 'CommandOrControl+1'),
      item('Changes', 'changes', 'CommandOrControl+2'),
      item('Explorer', 'explorer', 'CommandOrControl+3'),
      { type: 'separator' },
      item('Context…', 'context'),
      item('Usage…', 'usage'),
      item('Log…', 'log'),
      { type: 'separator' },
      ...(opts.dev ? [{ role: 'reload' } as MenuItemConstructorOptions, { role: 'forceReload' } as MenuItemConstructorOptions, { role: 'toggleDevTools' } as MenuItemConstructorOptions, { type: 'separator' } as MenuItemConstructorOptions] : []),
      { role: 'resetZoom' },
      { role: 'zoomIn' },
      { role: 'zoomOut' },
      { type: 'separator' },
      { role: 'togglefullscreen' }
    ]
  }
  const window: MenuItemConstructorOptions = {
    label: 'Window',
    submenu: [
      { role: 'minimize' },
      { role: 'zoom' },
      { type: 'separator' },
      { role: 'front' }
    ]
  }
  return [...(mac ? [appMenu] : []), file, edit, view, window]
}

export function install(opts: { dev: boolean }): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate(template(opts)))
}
