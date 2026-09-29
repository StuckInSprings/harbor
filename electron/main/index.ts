import { app, BrowserWindow, Notification, shell, session, globalShortcut } from 'electron'
import { join } from 'node:path'
import * as db from './db'
import { initDb } from './db'
import { housekeep } from './maintenance'
import * as sandbox from './sandbox'
import * as mcp from './mcp'
import * as commands from './commands'
import * as otel from './otel'
import * as bridge from './bridge'
import { shouldNotify } from '../../shared/approval'
import * as or from './openrouter'
import { launch } from './ipc/turns'
import { broadcast } from './ipc/shared'
import * as appmenu from './appmenu'
import { registerIpc } from './ipc'
import * as launcher from './launcher'
import { installEditingMenu } from './editing'
import * as log from './log'

/*
  This build keeps its data apart from any other Harbor on the machine. Every
  caller of getPath('userData') runs after app ready, well after this line.
*/
app.setPath('userData', join(app.getPath('appData'), 'harbor-showroom'))

const isDev = !app.isPackaged

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    // Down to 720 the layout bends: the inspector and then the sidebar float over the conversation.
    minWidth: 720,
    minHeight: 700,
    show: false,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 22 },
    backgroundColor: '#0B1418',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // Underline, never rewrite: the menu offers the suggestions.
      spellcheck: true
    }
  })
  installEditingMenu(win)

  win.once('ready-to-show', () => win.show())

  // The renderer never navigates. Links go to the system browser, and only https.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    const devServer = process.env.ELECTRON_RENDERER_URL
    if (devServer && url.startsWith(devServer)) return
    e.preventDefault()
  })

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}

/*
  A conversation popped out: the same renderer in a small window that stays
  above everything else, opened on one conversation with no sidebar. One
  window per conversation; asking again brings the one there is forward.
*/
const popped = new Map<string, BrowserWindow>()
const isPoppedOut = (conversationId: string): boolean => {
  const w = popped.get(conversationId)
  return !!w && !w.isDestroyed()
}
/* A pop-out closing is news to the main window: a throwaway it was holding open can go now. */
let onPopClosed: (conversationId: string) => void = () => {}
function popOut(conversationId: string): void {
  const existing = popped.get(conversationId)
  if (existing && !existing.isDestroyed()) {
    existing.show()
    existing.focus()
    return
  }
  const win = new BrowserWindow({
    width: 620,
    height: 780,
    minWidth: 480,
    minHeight: 420,
    show: false,
    alwaysOnTop: true,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 22 },
    backgroundColor: '#0B1418',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: true
    }
  })
  installEditingMenu(win)
  win.setAlwaysOnTop(true, 'floating')
  // Shown and given the keyboard, so the question can be typed the moment the window is up.
  win.once('ready-to-show', () => {
    win.show()
    win.focus()
    win.webContents.focus()
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    const devServer = process.env.ELECTRON_RENDERER_URL
    if (devServer && url.startsWith(devServer)) return
    e.preventDefault()
  })
  win.on('closed', () => {
    popped.delete(conversationId)
    onPopClosed(conversationId)
  })
  const hash = `#pop=${encodeURIComponent(conversationId)}`
  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(`${process.env.ELECTRON_RENDERER_URL}${hash}`)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'), { hash: hash.slice(1) })
  }
  popped.set(conversationId, win)
}

// Background commands the agent started do not outlive the app.
app.on('before-quit', () => {
  commands.stopAll()
  void otel.stop()
  void bridge.stop()
})

app.whenReady().then(() => {
  // Network egress is OpenRouter only. Everything else in the renderer is local.
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const url = details.url
    const allowed =
      url.startsWith('file://') ||
      url.startsWith('devtools://') ||
      url.startsWith('blob:') ||
      url.startsWith('data:') ||
      url.startsWith('https://openrouter.ai/') ||
      (isDev && url.startsWith('http://localhost')) ||
      (isDev && url.startsWith('ws://localhost'))
    callback({ cancel: !allowed })
  })

  initDb()
  // Throwaways from a session that ended without leaving them properly.
  const purged = db.purgeScratch()
  if (purged) log.info('app', 'discarded leftover quick questions', { count: purged })
  log.info('app', 'started', { version: app.getVersion(), electron: process.versions.electron })
  void sandbox.init()
  void mcp.init()
  setTimeout(() => void housekeep().catch((e) => log.warn('housekeeping', 'failed', { error: (e as Error).message })), 15_000)
  appmenu.install({ dev: isDev })
  const win = createWindow()
  onPopClosed = (id) => {
    if (!win.isDestroyed()) win.webContents.send('ui:popClosed', id)
  }
  registerIpc(win, { popOut, isPoppedOut })
  const toFront = (): boolean => {
    if (win.isDestroyed()) return false
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    return true
  }
  /*
    Off unless the person turned it on; then Claude Code can orchestrate and
    judge director runs through it. What it wants the person to know (an
    interview waiting on them, a review) is a notice in the window, and a
    desktop notification when the window is not in front.
  */
  bridge.configure({
    launch,
    cancel: or.cancel,
    changed: () => broadcast('conversations:changed', null),
    notice: (n) => {
      broadcast('bridge:notice', n)
      const focused = BrowserWindow.getAllWindows().some((w) => !w.isDestroyed() && w.isFocused())
      if (!Notification.isSupported() || !shouldNotify({ focused, setting: db.getSetting('notify_approvals') })) return
      const note = new Notification({ title: n.kind === 'review' ? "Claude's review" : 'An interview is waiting on you', body: n.text })
      note.on('click', () => {
        if (toFront()) win.webContents.send('ui:openConversation', n.conversationId)
      })
      note.show()
    }
  })
  void bridge.init()
  launcher.init(join(__dirname, '../preload/index.js'), {
    openConversation: (id) => {
      if (toFront()) win.webContents.send('ui:openConversation', id)
    },
    newConversationIn: (projectId) => {
      if (toFront()) win.webContents.send('ui:newConversationIn', projectId)
    },
    // The question is asked the way the hotkey asks one: a throwaway conversation in a pop-out, but with the words already sent.
    ask: (question) => {
      if (!win.isDestroyed()) win.webContents.send('ui:quickQuestion', question)
    }
  })

  /*
    A failure in the main process would otherwise leave the interface looking
    fine while nothing works. Report it to the window instead of dying quietly.
  */
  const report = (label: string, err: unknown): void => {
    const message = err instanceof Error ? err.message : String(err)
    log.error('main', label, { error: message })
    if (!win.isDestroyed()) win.webContents.send('app:error', `${label}: ${message}`)
  }
  process.on('uncaughtException', (err) => report('Something failed in the background', err))
  process.on('unhandledRejection', (err) => report('A background task failed', err))

  /*
    On a Mac the red button hides the window; the app and its handlers live
    on, and the Dock brings the same window back. Creating a second window
    registered every handler twice, and the main process stopped answering.
  */
  let quitting = false
  app.on('before-quit', () => {
    quitting = true
  })

  /*
    A quick question from anywhere: one key, and a small window on top
    with a throwaway conversation in it. The main window makes the
    conversation, since it knows the project and the model; the shortcut
    only asks it to.
  */
  const hotkey = 'CommandOrControl+\\'
  const registered = globalShortcut.register(hotkey, () => {
    if (!win.isDestroyed()) win.webContents.send('ui:quickQuestion')
  })
  if (registered) log.info('app', 'quick question hotkey registered', { hotkey })
  else log.warn('app', 'quick question hotkey could not be registered; another app holds it', { hotkey })
  app.on('will-quit', () => globalShortcut.unregisterAll())
  win.on('close', (e) => {
    if (process.platform === 'darwin' && !quitting) {
      e.preventDefault()
      win.hide()
    }
  })
  app.on('activate', () => {
    if (!win.isDestroyed()) win.show()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
