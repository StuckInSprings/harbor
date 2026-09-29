/**
 * Ranking for the launcher: how well a query fits an application's name,
 * and how much the person's own history should lift it. Pure, so it can be
 * tested without a window.
 */
export interface Entry {
  /** A bundle path, or a URL the system opens — a settings pane. */
  path: string
  name: string
  /** A second line under the name: where a pane lives, for instance. */
  hint?: string
}

/** The settings panes, by the identifiers System Settings answers to. Sound, Bluetooth and the rest open straight to their pane. */
export const SETTINGS_PANES: { name: string; id: string }[] = [
  { name: 'Wi-Fi', id: 'com.apple.wifi-settings-extension' },
  { name: 'Bluetooth', id: 'com.apple.BluetoothSettings' },
  { name: 'Network', id: 'com.apple.Network-Settings.extension' },
  { name: 'Battery', id: 'com.apple.Battery-Settings.extension' },
  { name: 'General', id: 'com.apple.systempreferences.GeneralSettings' },
  { name: 'Software Update', id: 'com.apple.Software-Update-Settings.extension' },
  { name: 'Storage', id: 'com.apple.settings.Storage' },
  { name: 'Login Items', id: 'com.apple.LoginItems-Settings.extension' },
  { name: 'Sharing', id: 'com.apple.Sharing-Settings.extension' },
  { name: 'Time Machine', id: 'com.apple.Time-Machine-Settings.extension' },
  { name: 'Date & Time', id: 'com.apple.Date-Time-Settings.extension' },
  { name: 'Language & Region', id: 'com.apple.Localization-Settings.extension' },
  { name: 'Appearance', id: 'com.apple.Appearance-Settings.extension' },
  { name: 'Accessibility', id: 'com.apple.Accessibility-Settings.extension' },
  { name: 'Control Center', id: 'com.apple.ControlCenter-Settings.extension' },
  { name: 'Siri & Spotlight', id: 'com.apple.Siri-Settings.extension' },
  { name: 'Privacy & Security', id: 'com.apple.settings.PrivacySecurity.extension' },
  { name: 'Desktop & Dock', id: 'com.apple.Desktop-Settings.extension' },
  { name: 'Displays', id: 'com.apple.Displays-Settings.extension' },
  { name: 'Wallpaper', id: 'com.apple.Wallpaper-Settings.extension' },
  { name: 'Screen Saver', id: 'com.apple.ScreenSaver-Settings.extension' },
  { name: 'Notifications', id: 'com.apple.Notifications-Settings.extension' },
  { name: 'Sound', id: 'com.apple.Sound-Settings.extension' },
  { name: 'Focus', id: 'com.apple.Focus-Settings.extension' },
  { name: 'Screen Time', id: 'com.apple.Screen-Time-Settings.extension' },
  { name: 'Lock Screen', id: 'com.apple.Lock-Screen-Settings.extension' },
  { name: 'Touch ID & Password', id: 'com.apple.Touch-ID-Settings.extension' },
  { name: 'Users & Groups', id: 'com.apple.Users-Groups-Settings.extension' },
  { name: 'Passwords', id: 'com.apple.Passwords-Settings.extension' },
  { name: 'Internet Accounts', id: 'com.apple.Internet-Accounts-Settings.extension' },
  { name: 'Wallet & Apple Pay', id: 'com.apple.WalletSettingsExtension' },
  { name: 'Keyboard', id: 'com.apple.Keyboard-Settings.extension' },
  { name: 'Trackpad', id: 'com.apple.Trackpad-Settings.extension' },
  { name: 'Mouse', id: 'com.apple.Mouse-Settings.extension' },
  { name: 'Printers & Scanners', id: 'com.apple.Print-Scan-Settings.extension' },
  { name: 'Game Center', id: 'com.apple.Game-Center-Settings.extension' }
]
export const SETTINGS_SCHEME = 'x-apple.systempreferences:'
export const paneUrl = (id: string): string => `${SETTINGS_SCHEME}${id}`
export const isPane = (path: string): boolean => path.startsWith(SETTINGS_SCHEME)
export interface Use {
  count: number
  last: number
}

/** How well a query fits a name: the whole name best, then a prefix, a word start, a substring, then a subsequence. */
export function matchScore(query: string, name: string): number {
  const q = query.trim().toLowerCase()
  const n = name.toLowerCase()
  if (!q) return 1
  if (n === q) return 120
  if (n.startsWith(q)) return 100
  if (n.split(/[\s\-_.]+/).some((w) => w.startsWith(q))) return 80
  if (n.includes(q)) return 60
  let j = 0
  for (const c of n) {
    if (c === q[j]) j++
    if (j === q.length) break
  }
  return j === q.length ? 30 : 0
}

/** Use count decayed with a two-week half-life; an app picked often and lately outranks one picked once a year ago. */
export function frecency(use: Use | undefined, now = Date.now()): number {
  if (!use) return 0
  const days = Math.max(0, now - use.last) / 86_400_000
  return use.count * Math.pow(0.5, days / 14)
}

/** The apps the person named, in their order. The first is the one a bare letter should land on. */
export const FAVOURITES_SETTING = 'launcher_favourites'
export const DEFAULT_FAVOURITES = ['Harbor', 'Claude', 'Zen', 'iA Writer', 'Visual Studio Code', 'Sublime Text', 'Discord']

/** One name per line, blank lines dropped. */
export function parseFavourites(text: string | null | undefined): string[] {
  return (text ?? '')
    .split(/\r?\n|,/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/** Where a name sits in the favourites, or Infinity when it is not one of them. */
export function favouriteRank(name: string, favourites: string[]): number {
  const n = name.trim().toLowerCase()
  const i = favourites.findIndex((f) => f.trim().toLowerCase() === n)
  return i === -1 ? Infinity : i
}

/*
  A favourite is worth one step of fit: enough that a word inside its name
  beats a stranger's first letters, not enough to reach past two steps. So
  "h" is Harbor over Hammerspoon, "c" is Claude, and "co" is Visual Studio
  Code — Claude never matched "co" at all, and Console's head start is one
  step, which the favourite covers. Among equal fits the named order
  decides, then what the person opens most and most recently, then the name.
*/
const FAVOURITE_STEP = 25

/*
  How much use may lift an app past a better textual fit. Off, use only
  breaks ties, as it always did; at each step up, a few picks are worth
  more, but never a favourite's step, so the named order still stands.
  The person sets this, and can reset the counts, since a week of opening
  one app can otherwise leave it in the way for a month.
*/
export type Sensitivity = 'off' | 'low' | 'medium' | 'high'
export const SENSITIVITY_SETTING = 'launcher_sensitivity'
export const DEFAULT_SENSITIVITY: Sensitivity = 'medium'
export const SENSITIVITIES: Sensitivity[] = ['off', 'low', 'medium', 'high']
const LIFT_CAP: Record<Sensitivity, number> = { off: 0, low: 6, medium: 12, high: 24 }
export const asSensitivity = (raw: string | null | undefined): Sensitivity => (SENSITIVITIES.includes(raw as Sensitivity) ? (raw as Sensitivity) : DEFAULT_SENSITIVITY)

/** What use adds to the fit: three points a decayed pick, up to the cap. */
export const useLift = (use: number, sensitivity: Sensitivity): number => Math.min(LIFT_CAP[sensitivity], use * 3)

export function rank(query: string, entries: Entry[], used: Record<string, Use>, now = Date.now(), favourites: string[] = [], sensitivity: Sensitivity = 'off'): Entry[] {
  return entries
    .map((e) => {
      const fav = favouriteRank(e.name, favourites)
      const fit = matchScore(query, e.name)
      const use = frecency(used[e.path], now)
      const lifted = fit > 0 ? fit + (fav !== Infinity ? FAVOURITE_STEP : 0) + (query.trim() ? useLift(use, sensitivity) : 0) : 0
      return { e, score: lifted, fav, use }
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.fav - b.fav || b.use - a.use || a.e.name.localeCompare(b.e.name))
    .map((x) => x.e)
}

/* ---------------------------------------------------- the index */

/**
 * Whether a bundle Spotlight knows of belongs in the launcher: the
 * Applications folders, the system's own, and anything the person keeps
 * under their home that is not a helper inside another bundle, a
 * framework, a package cache or a profile folder.
 */
export function keepFromSpotlight(path: string, home: string): boolean {
  if (!path.endsWith('.app')) return false
  const dir = path.slice(0, path.lastIndexOf('/'))
  if (dir.includes('.app/') || dir.endsWith('.app')) return false
  if (/\.framework\/|\/node_modules\/|\/pkgs\/|\/bin$|\/bin\//.test(dir)) return false
  if (dir.startsWith('/Applications') || dir.startsWith('/System/Applications')) return true
  if (dir === '/System/Library/CoreServices' || dir === '/System/Library/CoreServices/Applications') return true
  for (const no of [`${home}/Library`, '/Library', '/System', '/private', '/usr', '/opt', '/Volumes', '/nix', '/tmp']) if (dir === no || dir.startsWith(`${no}/`)) return false
  return dir.startsWith(`${home}/`) || dir.startsWith('/Users/')
}

/* ------------------------------------------------- Harbor's own */

/** Entries that front Harbor itself rather than another app. */
export const HARBOR_CONVERSATION = 'harbor:conversation:'
export const HARBOR_PROJECT = 'harbor:project:'
export const ASK_ENTRY = 'harbor:ask'
export const ASK_CLIP_ENTRY = 'harbor:ask-clip'
/** Entries that front the main window. The clipboard is Harbor's too, but the panel shows it itself; it is not one of these. */
export const isHarborEntry = (path: string): boolean => path.startsWith('harbor:') && path !== CLIPBOARD_ENTRY

/** A query that starts with @ is a project or a conversation by name. */
export const atQuery = (text: string): string | null => (text.trimStart().startsWith('@') ? text.trimStart().slice(1) : null)

/**
 * A question rather than a name: it starts with a question mark, or it
 * is long enough and has a space in it, which no app's name a person
 * would type does. The entry is offered under the apps, never over one.
 */
export function askQuery(text: string): string | null {
  const t = text.trim()
  if (t.startsWith('?')) return t.slice(1).trim() || null
  if (t.length >= 3 && (t.includes(' ') || t.endsWith('?'))) return t
  return null
}
export const forcedAsk = (text: string): boolean => text.trim().startsWith('?')

/** The question as it is sent, with what was copied quoted under it when asked about. */
export const askWithClip = (question: string, clip: string): string => `${question.trim()}\n\n\`\`\`\n${clip.trim()}\n\`\`\``

/* --------------------------------------------------------- clipboard */

export interface Clip {
  id: number
  text: string
  at: number
}
export const CLIPBOARD_ENTRY = 'harbor:clipboard'
export const CLIP_LIMIT = 10

/** A new copy goes to the front; the same text copied again moves up rather than appearing twice. */
export function pushClip(history: Clip[], text: string, at: number, nextId: number): Clip[] {
  if (!text.trim()) return history
  if (history[0]?.text === text) return history
  return [{ id: nextId, text, at }, ...history.filter((c) => c.text !== text)].slice(0, CLIP_LIMIT)
}

/** One line to show for a clip: its first line with something in it, spaces collapsed, cut to fit. */
export function clipPreview(text: string, max = 96): string {
  const line = text.split(/\r?\n/).find((l) => l.trim()) ?? ''
  const flat = line.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

export function ago(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 60) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min`
  const h = Math.round(m / 60)
  return h < 24 ? `${h} h` : `${Math.round(h / 24)} d`
}
