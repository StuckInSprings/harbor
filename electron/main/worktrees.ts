import { app } from 'electron'
import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import * as log from './log'

/**
 * A tree of its own for each worker a director sends out. A run has a
 * branch; each dispatched task gets a worktree checked out from it, under
 * Application Support, on a branch of its own, and the worker's
 * conversation is rooted there: it reads and writes a copy, and two
 * workers on one run cannot see each other's half-done files or step on
 * the person's. When the worker returns, its changes are committed on
 * its branch and merged into the run's; the tree and the branch then go.
 * A merge that fails leaves both where they are, and the report says so.
 */

const exec = promisify(execFile)

const IDENTITY = ['-c', 'user.name=Harbor', '-c', 'user.email=harbor@localhost', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null']

async function git(cwd: string, args: string[], timeout = 60_000): Promise<string> {
  const { stdout } = await exec('git', [...IDENTITY, ...args], { cwd, timeout, maxBuffer: 16 << 20, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
  return stdout.trim()
}

export interface Worktree {
  path: string
  branch: string
  /** The branch it came from, and goes back into. */
  base: string
}

/** Conversations rooted in a worktree while their worker runs: the root every reader of the conversation uses instead of the project's. */
const roots = new Map<string, string>()
export const rootOverride = (conversationId: string): string | null => roots.get(conversationId) ?? null
export const setRoot = (conversationId: string, root: string | null): void => {
  if (root) roots.set(conversationId, root)
  else roots.delete(conversationId)
}

export const worktreesDir = (): string => join(app.getPath('userData'), 'worktrees')

/** A worktree on a new branch from `base`, named for the run's branch and the task. */
export async function create(repoRoot: string, base: string, name: string): Promise<Worktree> {
  const safe = name.toLowerCase().replace(/[^a-z0-9/_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'task'
  // Beside the run's branch, not under it: a ref cannot be both a branch and a folder of branches.
  const branch = `${base}-${safe}`
  const path = join(worktreesDir(), safe.replace(/\//g, '-'))
  await fs.mkdir(worktreesDir(), { recursive: true })
  await fs.rm(path, { recursive: true, force: true })
  await git(repoRoot, ['worktree', 'add', '-q', '-b', branch, path, base])
  log.info('worktree', 'made', { branch, base })
  return { path, branch, base }
}

export interface Fold {
  /** True when nothing was left behind: nothing to merge, or merged and cleaned up. */
  merged: boolean
  /** The merge commit, when there was something to merge and it went in. */
  commit: string | null
  /** The files the worker's commit touched. */
  files: string[]
  /** Why it did not go in, when it did not. */
  reason: string | null
}

/**
 * The worker's changes committed on its branch and merged, with a merge
 * commit, into the base branch in the main tree. Only when the main tree
 * is still on that branch: the person may have moved. On any failure the
 * merge is abandoned, and the worktree and branch stay for the person or
 * the director to deal with by hand.
 */
export async function fold(repoRoot: string, wt: Worktree, message: string): Promise<Fold> {
  await git(wt.path, ['add', '-A', '--', '.'])
  const staged = await git(wt.path, ['diff', '--cached', '--name-only']).catch(() => '')
  const files = staged.split('\n').filter(Boolean).sort()
  if (!files.length) {
    await remove(repoRoot, wt, true)
    return { merged: true, commit: null, files: [], reason: null }
  }
  await git(wt.path, ['commit', '-q', '--no-verify', '-m', message])
  const on = await git(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => '')
  if (on !== wt.base) {
    const reason = `the main tree is on ${on || 'no branch'}, not ${wt.base}`
    log.warn('worktree', 'not merged', { branch: wt.branch, reason })
    return { merged: false, commit: null, files, reason }
  }
  try {
    await git(repoRoot, ['merge', '-q', '--no-ff', '--no-verify', '-m', message, wt.branch])
  } catch (e) {
    await git(repoRoot, ['merge', '--abort']).catch(() => undefined)
    const reason = (e as Error).message.split('\n').filter((l) => /conflict|overwritten|error:/i.test(l)).slice(0, 4).join(' ') || (e as Error).message.split('\n')[0]
    log.warn('worktree', 'not merged', { branch: wt.branch, reason })
    return { merged: false, commit: null, files, reason }
  }
  const commit = await git(repoRoot, ['rev-parse', '--short=10', 'HEAD']).catch(() => null)
  await remove(repoRoot, wt, true)
  log.info('worktree', 'merged', { branch: wt.branch, into: wt.base, commit, files: files.length })
  return { merged: true, commit, files, reason: null }
}

/** The worktree gone, and its branch with it when asked; nothing here fails loudly. */
export async function remove(repoRoot: string, wt: Worktree, dropBranch: boolean): Promise<void> {
  await git(repoRoot, ['worktree', 'remove', '--force', wt.path]).catch(() => fs.rm(wt.path, { recursive: true, force: true }).catch(() => undefined))
  await git(repoRoot, ['worktree', 'prune']).catch(() => undefined)
  if (dropBranch) await git(repoRoot, ['branch', '-D', wt.branch]).catch(() => undefined)
}
