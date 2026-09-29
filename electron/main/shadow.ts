import { app } from 'electron'
import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import * as log from './log'

/**
 * A snapshot of the whole project tree, taken either side of every agent
 * turn, in a repository of Harbor's own under Application Support whose
 * work tree is the project folder. The checkpoint log sees only the writes
 * the tools made; a command that rewrote a hundred files, or a worker
 * writing through the shell, left no record and no way back. This sees
 * the tree, whatever touched it, and never puts a commit in the project's
 * own history.
 *
 * The project's ignore rules apply, since it is the work tree; on top of
 * them the dependencies and the secrets the jail keeps from the model are
 * kept out of the snapshots too.
 */

const exec = promisify(execFile)

export const shadowDir = (projectId: string): string => join(app.getPath('userData'), 'shadow', projectId)

const EXCLUDE = ['node_modules/', '.env', '.env.*', '.DS_Store', '*.pem', '*.key', '*.p12', '*.pfx', '*.keystore', 'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519', '.npmrc', '.netrc', '.harbor/']

/** Every call carries the identity and the settings, so nothing depends on the person's git config. */
const IDENTITY = ['-c', 'user.name=Harbor', '-c', 'user.email=harbor@localhost', '-c', 'gc.auto=0', '-c', 'core.autocrlf=false', '-c', 'commit.gpgsign=false']

async function raw(projectId: string, root: string, args: string[], timeout = 60_000): Promise<string> {
  const { stdout } = await exec('git', [...IDENTITY, '--git-dir', shadowDir(projectId), '--work-tree', root, ...args], {
    cwd: root,
    timeout,
    maxBuffer: 16 << 20,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  })
  return stdout
}
const git = async (projectId: string, root: string, args: string[], timeout?: number): Promise<string> => (await raw(projectId, root, args, timeout)).trim()

async function ensure(projectId: string, root: string): Promise<void> {
  const dir = shadowDir(projectId)
  const there = await fs.stat(join(dir, 'HEAD')).then(() => true, () => false)
  if (there) return
  await fs.mkdir(dir, { recursive: true })
  await exec('git', ['init', '-q', '--bare', dir], { timeout: 30_000 })
  await exec('git', ['--git-dir', dir, 'config', 'core.bare', 'false'], { timeout: 30_000 })
  await fs.mkdir(join(dir, 'info'), { recursive: true })
  await fs.writeFile(join(dir, 'info', 'exclude'), `${EXCLUDE.join('\n')}\n`, 'utf8')
  log.info('shadow', 'shadow repository made', { project: projectId.slice(0, 8), root })
}

/**
 * The tree as it is now, as one commit. Empty commits are allowed, so a
 * snapshot always has a sha to record, and the sha is tagged so no
 * housekeeping can ever lose it. Null when git is not there or the tree
 * could not be read; a turn runs the same without its safety net, and the
 * log says so.
 */
export async function snapshot(projectId: string, root: string, label: string): Promise<string | null> {
  try {
    await ensure(projectId, root)
    await git(projectId, root, ['add', '-A', '--', '.'])
    await git(projectId, root, ['commit', '-q', '--allow-empty', '--no-verify', '-m', label])
    const sha = await git(projectId, root, ['rev-parse', 'HEAD'])
    await git(projectId, root, ['tag', '-f', `s-${sha.slice(0, 12)}`, sha])
    return sha
  } catch (e) {
    log.warn('shadow', 'no snapshot', { project: projectId.slice(0, 8), error: (e as Error).message.split('\n')[0] })
    return null
  }
}

/** The files that differ between two snapshots, as `A path`, `M path`, `D path`. */
export async function changed(projectId: string, root: string, from: string, to: string): Promise<{ status: string; path: string }[]> {
  const out = await git(projectId, root, ['diff', '--name-status', '-M', from, to]).catch(() => '')
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [status, ...rest] = line.split('\t')
      return { status: status.charAt(0), path: rest[rest.length - 1] ?? '' }
    })
}

/** One file as it was in a snapshot; null when it was not there. */
export async function fileAt(projectId: string, root: string, sha: string, path: string): Promise<string | null> {
  return raw(projectId, root, ['show', `${sha}:${path}`]).catch(() => null)
}

/**
 * The tree put back the way a snapshot has it. A snapshot of the present
 * is taken first, so a restore is itself a step with a way back, and then
 * the index and the tree are reset to the target: files it has are
 * rewritten, files it lacks are removed, and what the snapshots never
 * held — dependencies, secrets, the project's own .git — is not touched.
 * Returns the safety snapshot's sha.
 */
export async function restore(projectId: string, root: string, sha: string): Promise<string | null> {
  const safety = await snapshot(projectId, root, `before restoring ${sha.slice(0, 12)}`)
  if (!safety) throw new Error('The tree could not be snapshotted before the restore, so nothing was changed.')
  await git(projectId, root, ['reset', '-q', '--hard', sha])
  log.info('shadow', 'tree restored', { project: projectId.slice(0, 8), to: sha.slice(0, 12), safety: safety.slice(0, 12) })
  return safety
}
