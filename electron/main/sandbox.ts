import { tmpdir } from 'node:os'
import { SandboxManager, getDefaultWritePaths, type SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime'
import * as db from './db'
import * as log from './log'

/**
 * The shell, fenced. The path jail never covered run_command — a command
 * can name any path — so approval was the only boundary, and unattended
 * runs had none. Now a command the agent runs is wrapped in the operating
 * system's sandbox (Seatbelt on macOS): it may write in the project folder
 * and the usual scratch and cache places, read anything but the credential
 * folders, and reach only the domains the person has allowed, through a
 * proxy the runtime starts. A command that needs more asks to run outside
 * the sandbox, and that is always the person's call.
 *
 * Commands the person types are theirs and are not wrapped; hooks are the
 * project's own configured commands and are not wrapped either.
 */

export const ENABLED_SETTING = 'sandbox_commands'
export const DOMAINS_SETTING = 'sandbox_domains'

/** Where a coding agent's commands usually need to reach: package registries and the forges. */
export const DEFAULT_DOMAINS = [
  'registry.npmjs.org',
  'registry.yarnpkg.com',
  'github.com',
  '*.github.com',
  '*.githubusercontent.com',
  'pypi.org',
  'files.pythonhosted.org',
  'crates.io',
  '*.crates.io',
  'proxy.golang.org',
  'sum.golang.org'
]

/** What no command run by the agent may read: where keys and tokens live. */
const DENY_READ = ['~/.ssh', '~/.aws', '~/.gnupg', '~/.config/gh', '~/.netrc', '~/.npmrc', '~/.docker/config.json', '~/Library/Keychains']

let ready = false
let reason = 'not started'

export const isReady = (): boolean => ready
/** Why the sandbox is not on, in words; '' when it is. */
export const unavailable = (): string => (ready ? '' : reason)

export function enabledBySetting(): boolean {
  return db.getSetting(ENABLED_SETTING) !== '0'
}

export function domains(): string[] {
  const raw = db.getSetting(DOMAINS_SETTING) ?? ''
  const own = raw
    .split(/[\s,]+/)
    .map((d) => d.trim())
    .filter(Boolean)
  return own.length ? own : DEFAULT_DOMAINS
}

function config(): SandboxRuntimeConfig {
  return {
    network: { allowedDomains: domains(), deniedDomains: [], allowLocalBinding: true },
    filesystem: { denyRead: DENY_READ, allowRead: [], allowWrite: [], denyWrite: [] }
  } as SandboxRuntimeConfig
}

/** Starts the runtime (and its proxies) once; a failure leaves commands unsandboxed and says so in the log. */
export async function init(): Promise<void> {
  if (!enabledBySetting()) {
    ready = false
    reason = 'turned off in Settings'
    log.info('sandbox', 'off by setting')
    return
  }
  if (!SandboxManager.isSupportedPlatform()) {
    ready = false
    reason = 'not supported on this platform'
    log.warn('sandbox', reason)
    return
  }
  try {
    await SandboxManager.initialize(config(), undefined, true)
    ready = true
    reason = ''
    log.info('sandbox', 'ready', { domains: domains().length })
  } catch (e) {
    ready = false
    reason = (e as Error).message
    log.warn('sandbox', 'could not start; commands run unsandboxed', { error: reason })
  }
}

/** Settings changed: apply them. Turning it off releases nothing until the next start; turning it on starts it. */
export async function reconfigure(): Promise<void> {
  if (!enabledBySetting()) {
    if (ready) {
      await SandboxManager.reset().catch(() => undefined)
      ready = false
      reason = 'turned off in Settings'
      log.info('sandbox', 'turned off')
    }
    return
  }
  if (ready) {
    SandboxManager.updateConfig(config())
    log.info('sandbox', 'reconfigured', { domains: domains().length })
    return
  }
  await init()
}

/** A command as the sandbox will run it: argv and env for spawn, or null when the sandbox is not on. */
export async function wrap(
  command: string,
  root: string,
  opts: { id: string; signal?: AbortSignal }
): Promise<{ argv: string[]; env: NodeJS.ProcessEnv } | null> {
  if (!ready) return null
  const writable = [...new Set([root, tmpdir(), '/private/tmp', ...getDefaultWritePaths({ denyRead: DENY_READ })])]
  const custom = { filesystem: { denyRead: DENY_READ, allowRead: [], allowWrite: writable, denyWrite: [] } } as Partial<SandboxRuntimeConfig>
  return SandboxManager.wrapWithSandboxArgv(command, '/bin/zsh', custom, opts.signal, root, { commandId: opts.id, commandText: command })
}

/** The command's output, with what the sandbox refused appended in words, when it refused anything. */
export function explain(command: string, output: string): string {
  if (!ready) return output
  try {
    return SandboxManager.annotateStderrWithSandboxFailures(command, output)
  } catch {
    return output
  }
}

export function after(): void {
  if (!ready) return
  try {
    SandboxManager.cleanupAfterCommand()
  } catch {
    /* nothing to clean */
  }
}
