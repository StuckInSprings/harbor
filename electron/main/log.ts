import { app, shell } from 'electron'
import { createWriteStream, existsSync, renameSync, statSync, type WriteStream } from 'node:fs'
import { join } from 'node:path'

/**
 * A log, because guessing at a hang only fixes the causes you thought of.
 *
 * Two destinations at once: a file that survives a crash and can be read after
 * the fact, and a ring buffer the interface can show live while something is
 * stuck. Timings are recorded on the turn lifecycle specifically, since a hang
 * is defined by where the elapsed time stops making progress.
 */

export type Level = 'info' | 'warn' | 'error'

export interface LogLine {
  at: number
  level: Level
  scope: string
  message: string
  /** Small structured extras; kept short so a line stays readable. */
  detail?: Record<string, unknown>
}

const RING = 500
const MAX_BYTES = 2 * 1024 * 1024

const ring: LogLine[] = []
let stream: WriteStream | null = null
let listeners: ((line: LogLine) => void)[] = []

export const logPath = (): string => join(app.getPath('userData'), 'harbor.log')

function open(): WriteStream {
  if (stream) return stream
  const path = logPath()
  // Keep one previous file rather than growing without bound.
  try {
    if (existsSync(path) && statSync(path).size > MAX_BYTES) renameSync(path, `${path}.1`)
  } catch {
    /* rotation is a convenience, never a reason to lose logging */
  }
  stream = createWriteStream(path, { flags: 'a' })
  return stream
}

const format = (l: LogLine): string => {
  const t = new Date(l.at).toISOString().slice(11, 23)
  const extra = l.detail ? ` ${JSON.stringify(l.detail)}` : ''
  return `${t} ${l.level.toUpperCase().padEnd(5)} ${l.scope.padEnd(16)} ${l.message}${extra}\n`
}

export function log(
  level: Level,
  scope: string,
  message: string,
  detail?: Record<string, unknown>
): void {
  const line: LogLine = { at: Date.now(), level, scope, message, detail }
  ring.push(line)
  if (ring.length > RING) ring.shift()
  try {
    open().write(format(line))
  } catch {
    /* never let logging break the thing being logged */
  }
  for (const l of listeners) l(line)
}

export const info = (scope: string, message: string, detail?: Record<string, unknown>): void =>
  log('info', scope, message, detail)
export const warn = (scope: string, message: string, detail?: Record<string, unknown>): void =>
  log('warn', scope, message, detail)
export const error = (scope: string, message: string, detail?: Record<string, unknown>): void =>
  log('error', scope, message, detail)

export const recent = (): LogLine[] => [...ring]

export function onLine(handler: (line: LogLine) => void): () => void {
  listeners.push(handler)
  return () => {
    listeners = listeners.filter((l) => l !== handler)
  }
}

export const reveal = (): void => {
  shell.showItemInFolder(logPath())
}

/** Milliseconds since a mark, for recording where the time actually went. */
export function since(from: number): number {
  return Date.now() - from
}
