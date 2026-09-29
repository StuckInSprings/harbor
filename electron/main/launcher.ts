import { app, BrowserWindow, globalShortcut, ipcMain, screen, shell, clipboard } from 'electron'
import { promises as fs } from 'node:fs'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import * as db from './db'
import * as log from './log'
import { rank, matchScore, type Entry, type Use, SETTINGS_PANES, paneUrl, isPane, SETTINGS_SCHEME, CLIPBOARD_ENTRY, pushClip, type Clip, parseFavourites, FAVOURITES_SETTING, DEFAULT_FAVOURITES, SENSITIVITY_SETTING, asSensitivity, keepFromSpotlight, HARBOR_CONVERSATION, HARBOR_PROJECT, ASK_ENTRY, ASK_CLIP_ENTRY, isHarborEntry, atQuery, askQuery, forcedAsk, askWithClip, type Sensitivity } from '../../shared/launcher'

/*
  The launcher: one key, a few letters, an application opens or comes to
  the front. Harbor is already running, so the panel is built once and
  hidden; showing it is instant. The index is the Applications folders,
  read again each time the panel opens, since a readdir of five folders
  costs nothing. Ranking is the match times how often and how recently
  the app was picked, so the app you mean rises after a few days.
*/

const APP_DIRS = [
  '/Applications',
  '/Applications/Utilities',
  '/System/Applications',
  '/System/Applications/Utilities',
  join(homedir(), 'Applications')
]
export const HOTKEY_SETTING = 'launcher_hotkey'
export const DEFAULT_HOTKEY = 'CommandOrControl+Space'
const RESULTS = 8

export interface LauncherItem extends Entry {
  icon: string
}

let index: Entry[] = []
const icons = new Map<string, string>()
let uses: Record<string, Use> = {}
let panel: BrowserWindow | null = null
let bound: string | null = null

/** What the launcher asks of the main window: a conversation fronted, a new one made, a question asked. */
export interface Front {
  openConversation: (id: string) => void
  newConversationIn: (projectId: string) => void
  ask: (question: string) => void
}
let front: Front | null = null

/*
  What Launch Services knows, through Spotlight: every application bundle
  on the machine, wherever it was put, which the folder walk below cannot
  see. Asked in the background and kept; the walk is the floor when
  Spotlight is off or slow.
*/
let spotlight: Entry[] = []
let spotlightAt = 0
const SPOTLIGHT_EVERY_MS = 60_000
function askSpotlight(): void {
  if (Date.now() - spotlightAt < SPOTLIGHT_EVERY_MS) return
  spotlightAt = Date.now()
  execFile('mdfind', ["kMDItemContentType == 'com.apple.application-bundle'"], { timeout: 5_000, maxBuffer: 8 << 20 }, (err, stdout) => {
    if (err) {
      log.warn('launcher', 'spotlight did not answer; the folders alone are indexed', { error: err.message.split('\n')[0] })
      return
    }
    const home = homedir()
    spotlight = stdout
      .split('\n')
      .filter((p) => keepFromSpotlight(p, home))
      .map((path) => ({ path, name: path.slice(path.lastIndexOf('/') + 1, -4) }))
    log.info('launcher', 'indexed through spotlight', { apps: spotlight.length })
  })
}

const usesFile = (): string => join(app.getPath('userData'), 'launcher.json')

async function loadUses(): Promise<void> {
  try {
    uses = JSON.parse(await fs.readFile(usesFile(), 'utf8')) as Record<string, Use>
  } catch {
    uses = {}
  }
}
async function saveUses(): Promise<void> {
  await fs.writeFile(usesFile(), JSON.stringify(uses), 'utf8').catch(() => {})
}

/** Every .app in the known folders, one level of subfolder allowed, as installers like to nest. */
export async function scan(): Promise<Entry[]> {
  const out = new Map<string, Entry>()
  for (const dir of APP_DIRS) {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const e of entries) {
      if (e.name.startsWith('.')) continue
      if (e.name.endsWith('.app')) {
        const path = join(dir, e.name)
        out.set(path, { path, name: e.name.slice(0, -4) })
      } else if (e.isDirectory()) {
        const sub = await fs.readdir(join(dir, e.name)).catch(() => [] as string[])
        for (const n of sub) {
          if (!n.endsWith('.app')) continue
          const path = join(dir, e.name, n)
          out.set(path, { path, name: n.slice(0, -4) })
        }
      }
    }
  }
  // Finder lives outside the application folders; it is the one everyone wants.
  const finder = '/System/Library/CoreServices/Finder.app'
  if (await fs.stat(finder).catch(() => null)) out.set(finder, { path: finder, name: 'Finder' })
  // What Spotlight found beyond the folders, the last time it was asked.
  askSpotlight()
  for (const e of spotlight) if (!out.has(e.path)) out.set(e.path, e)
  // Every settings pane, so "sound" goes straight to Sound rather than to System Settings' front page.
  for (const pane of SETTINGS_PANES) out.set(paneUrl(pane.id), { path: paneUrl(pane.id), name: pane.name, hint: 'System Settings' })
  // Harbor's own: the last few things copied, picked from the same panel.
  out.set(CLIPBOARD_ENTRY, { path: CLIPBOARD_ENTRY, name: 'Clipboard history', hint: 'Harbor' })
  index = [...out.values()]
  return index
}

const SETTINGS_APP = '/System/Applications/System Settings.app'

/*
  An app's icon, read from its own bundle: Info.plist names the .icns in
  Resources, and the system's sips tool renders it to a 64px PNG that is
  kept on disk. Apps whose icon lives only in an asset catalogue have no
  .icns, and those fall back to Electron's icon service. The cache is
  keyed by the bundle's path and when it last changed, so an update that
  brings a new icon is seen, and the old file is left to the sweep.
*/
const iconDir = (): string => join(app.getPath('userData'), 'launcher-icons')
/** The bundle's path and its Info.plist's modification time, as one cache key. */
async function iconKey(path: string): Promise<string> {
  const st = (await fs.stat(join(path, 'Contents', 'Info.plist')).catch(() => null)) ?? (await fs.stat(path).catch(() => null))
  return `${path}@${st ? Math.round(st.mtimeMs) : 0}`
}
async function bundleIcon(path: string, key: string): Promise<string | null> {
  const plist = await fs.readFile(join(path, 'Contents', 'Info.plist'), 'utf8').catch(() => null)
  if (!plist) return null
  const m = /<key>CFBundleIconFile<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)
  if (!m) return null
  const name = m[1].trim()
  const icns = join(path, 'Contents', 'Resources', name.endsWith('.icns') ? name : `${name}.icns`)
  if (!(await fs.stat(icns).catch(() => null))) return null
  await fs.mkdir(iconDir(), { recursive: true })
  const out = join(iconDir(), `${createHash('sha1').update(key).digest('hex')}.png`)
  if (!(await fs.stat(out).catch(() => null))) {
    await new Promise<void>((resolve, reject) => {
      execFile('sips', ['-s', 'format', 'png', '-Z', '64', icns, '--out', out], (err) => (err ? reject(err) : resolve()))
    })
  }
  const png = await fs.readFile(out)
  return `data:image/png;base64,${png.toString('base64')}`
}

async function iconFor(path: string): Promise<string> {
  if (isPane(path)) return iconFor(SETTINGS_APP)
  if (path === CLIPBOARD_ENTRY || isHarborEntry(path)) return iconFor(ownBundle())
  const key = await iconKey(path)
  const cached = icons.get(key)
  if (cached !== undefined) return cached
  let url = ''
  try {
    url = (await bundleIcon(path, key)) ?? ''
  } catch (e) {
    log.warn('launcher', 'bundle icon failed', { app: path.split('/').pop(), error: (e as Error).message })
  }
  if (!url) {
    try {
      const img = await app.getFileIcon(path, { size: 'normal' })
      url = img.isEmpty() ? '' : img.toDataURL()
    } catch (e) {
      log.warn('launcher', 'icon service failed', { app: path.split('/').pop(), error: (e as Error).message })
    }
  }
  icons.set(key, url)
  return url
}

/** Harbor's own projects and conversations, by name, for a query that starts with @. */
function harborEntries(text: string): Entry[] {
  // Archived projects, and what is in them, are put away here too.
  const projects = db.listProjects().filter((p) => !p.archived)
  const byId = new Map(projects.map((p) => [p.id, p.name]))
  const out: Entry[] = projects.map((p) => ({ path: `${HARBOR_PROJECT}${p.id}`, name: p.name, hint: 'Project' }))
  const conversations = db
    .listConversations()
    .filter((c) => !c.archived && !c.scratch && (c.role === 'chat' || c.role === 'director') && byId.has(c.projectId))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 200)
  for (const c of conversations) out.push({ path: `${HARBOR_CONVERSATION}${c.id}`, name: c.title, hint: byId.get(c.projectId) ?? 'Conversation' })
  const q = text.trim()
  return out
    .map((e, i) => ({ e, fit: matchScore(q, e.name), i }))
    .filter((x) => x.fit > 0)
    .sort((a, b) => b.fit - a.fit || a.i - b.i)
    .map((x) => x.e)
}

const sensitivity = (): Sensitivity => asSensitivity(db.getSetting(SENSITIVITY_SETTING))

async function query(text: string): Promise<LauncherItem[]> {
  const at = atQuery(text)
  let top: Entry[]
  if (at !== null) {
    top = harborEntries(at).slice(0, RESULTS)
  } else {
    const favourites = parseFavourites(db.getSetting(FAVOURITES_SETTING) ?? DEFAULT_FAVOURITES.join('\n'))
    top = rank(text, index, uses, Date.now(), favourites, sensitivity()).slice(0, RESULTS)
    // A question goes to Harbor: first when it was marked as one, otherwise under whatever apps fit.
    const question = askQuery(text)
    if (question) {
      const asks: Entry[] = [{ path: ASK_ENTRY, name: `Ask Harbor: ${question}`, hint: 'Quick question' }]
      if (clips[0]) asks.push({ path: ASK_CLIP_ENTRY, name: `Ask about what was copied: ${question}`, hint: 'With the last clip' })
      top = forcedAsk(text) ? asks : [...top.slice(0, RESULTS - asks.length), ...asks]
    }
  }
  return Promise.all(top.map(async (e) => ({ ...e, icon: await iconFor(e.path) })))
}

/** Harbor's own entries: the main window fronted, and told what to show or ask. */
function openHarbor(path: string, text: string): void {
  hide()
  if (!front) throw new Error('Harbor is not ready.')
  if (path === ASK_ENTRY || path === ASK_CLIP_ENTRY) {
    const question = askQuery(text) ?? text.trim()
    front.ask(path === ASK_CLIP_ENTRY && clips[0] ? askWithClip(question, clips[0].text) : question)
    log.info('launcher', 'asked', { chars: question.length, withClip: path === ASK_CLIP_ENTRY })
  } else if (path.startsWith(HARBOR_CONVERSATION)) {
    front.openConversation(path.slice(HARBOR_CONVERSATION.length))
    log.info('launcher', 'opened', { conversation: path.slice(HARBOR_CONVERSATION.length, HARBOR_CONVERSATION.length + 8) })
  } else if (path.startsWith(HARBOR_PROJECT)) {
    const projectId = path.slice(HARBOR_PROJECT.length)
    const latest = db
      .listConversations()
      .filter((c) => c.projectId === projectId && !c.archived && !c.scratch && c.role === 'chat')
      .sort((a, b) => b.updatedAt - a.updatedAt)[0]
    if (latest) front.openConversation(latest.id)
    else front.newConversationIn(projectId)
    log.info('launcher', 'opened', { project: projectId.slice(0, 8), latest: !!latest })
  }
}

async function open(path: string, text = ''): Promise<void> {
  if (isHarborEntry(path)) {
    openHarbor(path, text)
    return
  }
  if (path === CLIPBOARD_ENTRY) {
    // The panel shows the clips itself; this only counts the pick so the entry rises like any other.
    const u = uses[path] ?? { count: 0, last: 0 }
    uses[path] = { count: u.count + 1, last: Date.now() }
    void saveUses()
    return
  }
  const use = uses[path] ?? { count: 0, last: 0 }
  uses[path] = { count: use.count + 1, last: Date.now() }
  void saveUses()
  hide()
  // A pane is a URL the system hands to System Settings; a bundle launches, or comes forward when it is already running.
  if (isPane(path)) {
    await shell.openExternal(path)
    log.info('launcher', 'opened', { pane: path.slice(SETTINGS_SCHEME.length) })
    return
  }
  const err = await shell.openPath(path)
  if (err) throw new Error(err)
  log.info('launcher', 'opened', { app: path.split('/').pop() })
}

/*
  Clipboard history. Electron has no event for a copy, so the text on the
  clipboard is read a little more than once a second and kept when it has
  changed: the last ten, in memory only, never on disk. What a password
  manager marks as concealed or transient is left alone.
*/
let clips: Clip[] = []
let clipSeq = 1
let lastSeen = ''
const SECRET_TYPES = ['org.nspasteboard.ConcealedType', 'org.nspasteboard.TransientType', 'org.nspasteboard.AutoGeneratedType']
function watchClipboard(): void {
  let reading = false
  const tick = async (first: boolean): Promise<void> => {
    if (reading) return
    reading = true
    try {
      const text = await clipboard.readText()
      if (first) lastSeen = text
      if (text === lastSeen) return
      lastSeen = text
      for (const t of SECRET_TYPES) if (await clipboard.has(t)) return
      clips = pushClip(clips, text, Date.now(), clipSeq++)
    } catch {
      // An unreadable clipboard is an empty tick.
    } finally {
      reading = false
    }
  }
  void tick(true)
  setInterval(() => void tick(false), 800)
}

/** Harbor's own bundle, for its icon; the binary sits three folders inside it. */
function ownBundle(): string {
  const exe = app.getPath('exe')
  const i = exe.indexOf('.app/')
  return i === -1 ? exe : exe.slice(0, i + 4)
}

/*
  A clip chosen: back onto the clipboard, the panel away, and Cmd+V into
  whatever was in front before. If Harbor itself would take the keystroke,
  it steps aside first. The keystroke needs Accessibility; without it the
  text is still on the clipboard and the person pastes it themselves.
*/
async function pasteClip(id: number): Promise<boolean> {
  const clip = clips.find((c) => c.id === id)
  if (!clip) throw new Error('That clip is gone.')
  await clipboard.writeText(clip.text)
  lastSeen = clip.text
  clips = pushClip(clips, clip.text, Date.now(), clipSeq++)
  hide()
  await new Promise((r) => setTimeout(r, 90))
  if (BrowserWindow.getFocusedWindow()) {
    app.hide()
    await new Promise((r) => setTimeout(r, 120))
  }
  return new Promise<boolean>((resolve) => {
    execFile('osascript', ['-e', 'tell application "System Events" to keystroke "v" using command down'], (err) => {
      if (err) log.warn('launcher', 'could not paste; the clip is on the clipboard', { error: err.message.split('\n')[0].slice(0, 160) })
      else log.info('launcher', 'pasted a clip', { chars: clip.text.length })
      resolve(!err)
    })
  })
}

function place(win: BrowserWindow): void {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const { x, y, width, height } = display.workArea
  const [w] = win.getSize()
  win.setPosition(Math.round(x + (width - w) / 2), Math.round(y + height * 0.22))
}

function show(): void {
  if (!panel || panel.isDestroyed()) return
  if (panel.isVisible()) {
    hide()
    return
  }
  void scan()
  place(panel)
  panel.webContents.send('launcher:show')
  panel.show()
  panel.focus()
}

function hide(): void {
  if (panel && !panel.isDestroyed() && panel.isVisible()) panel.hide()
}

/** Register the hotkey, releasing the previous one; false when another app holds the key. */
export function bind(hotkey: string): boolean {
  const key = hotkey.trim() || DEFAULT_HOTKEY
  if (bound) globalShortcut.unregister(bound)
  bound = null
  const ok = globalShortcut.register(key, show)
  if (ok) {
    bound = key
    log.info('launcher', 'hotkey registered', { hotkey: key })
  } else {
    log.warn('launcher', 'hotkey could not be registered; another app holds it', { hotkey: key })
  }
  return ok
}

function handle<T>(channel: string, fn: (...args: any[]) => T | Promise<T>): void {
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      return { ok: true, data: await fn(...args) }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })
}

export function init(preload: string, main: Front): void {
  front = main
  watchClipboard()
  void loadUses()
  void scan()
  panel = new BrowserWindow({
    width: 640,
    height: 440,
    show: false,
    /*
      A non-activating panel on macOS: it takes the keyboard without making
      Harbor the active app, so summoning it leaves the app you were in
      where it was and does not raise Harbor's own windows behind it.
    */
    ...(process.platform === 'darwin' ? { type: 'panel' as const } : {}),
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: false }
  })
  panel.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  panel.setAlwaysOnTop(true, 'screen-saver')
  panel.on('blur', hide)
  panel.on('closed', () => {
    panel = null
  })
  if (process.env.ELECTRON_RENDERER_URL) {
    void panel.loadURL(`${process.env.ELECTRON_RENDERER_URL}/launcher.html`)
  } else {
    void panel.loadFile(join(__dirname, '../renderer/launcher.html'))
  }

  handle('launcher:query', (text: string) => query(String(text ?? '')))
  handle('launcher:open', (path: string, text?: string) => open(String(path), String(text ?? '')))
  // Ranking: one app's count forgotten, or all of them; and how much use may lift an app.
  handle('launcher:forget', (path: string) => {
    delete uses[String(path)]
    void saveUses()
    return true
  })
  handle('launcher:resetRanking', () => {
    uses = {}
    void saveUses()
    log.info('launcher', 'ranking reset')
    return true
  })
  handle('launcher:sensitivity', () => sensitivity())
  handle('launcher:setSensitivity', (value: string) => {
    db.setSetting(SENSITIVITY_SETTING, asSensitivity(String(value)))
    return true
  })
  handle('launcher:clips', () => clips)
  handle('launcher:pasteClip', (id: number) => pasteClip(Number(id)))
  handle('launcher:hide', () => {
    hide()
    return true
  })
  // The window follows the panel's height, so the border is never cut off and an empty list leaves no dead space.
  handle('launcher:resize', (height: number) => {
    if (panel && !panel.isDestroyed()) {
      const [w] = panel.getSize()
      panel.setSize(w, Math.max(80, Math.min(900, Math.round(Number(height) || 0))))
    }
    return true
  })
  handle('launcher:hotkey', () => ({ hotkey: db.getSetting(HOTKEY_SETTING) || DEFAULT_HOTKEY, bound }))
  handle('launcher:favourites', () => db.getSetting(FAVOURITES_SETTING) ?? DEFAULT_FAVOURITES.join('\n'))
  handle('launcher:setFavourites', (text: string) => {
    db.setSetting(FAVOURITES_SETTING, String(text ?? ''))
    return true
  })
  handle('launcher:setHotkey', (hotkey: string) => {
    const key = String(hotkey ?? '').trim()
    db.setSetting(HOTKEY_SETTING, key)
    if (!bind(key || DEFAULT_HOTKEY)) throw new Error(`${key || DEFAULT_HOTKEY} could not be registered; another app holds it. Free it there, or pick another key.`)
    return true
  })
  bind(db.getSetting(HOTKEY_SETTING) || DEFAULT_HOTKEY)
}
