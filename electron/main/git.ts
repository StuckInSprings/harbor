/**
 * The little git a run needs: where the repository is, what commit it is
 * on, whether the tree is clean, and a branch to work on. Nothing here
 * commits or merges; that stays the person's, or the director's through an
 * ordinary command they can read in the terminal pane.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

async function git(dir: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', args, { cwd: dir, timeout: 15_000, maxBuffer: 1 << 20 })
  return stdout.trim()
}

/** The repository's top folder, or null when the folder is not inside one. */
export async function repoRoot(dir: string): Promise<string | null> {
  try {
    return await git(dir, ['rev-parse', '--show-toplevel'])
  } catch {
    return null
  }
}

export async function headSha(dir: string): Promise<string | null> {
  try {
    return await git(dir, ['rev-parse', '--short=10', 'HEAD'])
  } catch {
    return null
  }
}

export async function currentBranch(dir: string): Promise<string | null> {
  try {
    const b = await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])
    return b === 'HEAD' ? null : b
  } catch {
    return null
  }
}

/** No changes, staged or not, and nothing untracked outside the ignore rules. */
export async function isClean(dir: string): Promise<boolean> {
  try {
    return (await git(dir, ['status', '--porcelain'])) === ''
  } catch {
    return false
  }
}

/** A new branch from HEAD, checked out. The name is made safe and unique. */
export async function createBranch(dir: string, name: string): Promise<string> {
  const safe = name.toLowerCase().replace(/[^a-z0-9/_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'run'
  await git(dir, ['checkout', '-b', safe])
  return safe
}

/** A name for a run's branch: harbor/<slug>-<yyyymmdd-hhmm>. */
export function runBranchName(slug: string, at: number): string {
  const d = new Date(at)
  const pad = (n: number): string => String(n).padStart(2, '0')
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`
  const s = slug.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'run'
  return `harbor/${s}-${stamp}`
}

/** Whether the folder itself is ignored by the repository it sits in, so nothing in it is tracked or diffable. */
export async function isIgnored(dir: string): Promise<boolean> {
  try {
    await run('git', ['check-ignore', '-q', '.'], { cwd: dir, timeout: 15_000 })
    return true
  } catch {
    return false
  }
}

/*
  What changed in a folder since a commit: committed on the branch or not,
  and files new to the repository. Paths are relative to the folder. For
  reading a run's work, not for anything that writes.
*/
export async function changesSince(dir: string, base: string): Promise<{ status: string; path: string }[]> {
  const tracked = await git(dir, ['diff', '--name-status', '--relative', base, '--', '.'])
  const untracked = await git(dir, ['ls-files', '--others', '--exclude-standard', '--', '.'])
  const rows = tracked
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [status, ...paths] = line.split('\t')
      return { status: status.startsWith('R') ? 'renamed' : status === 'A' ? 'added' : status === 'D' ? 'deleted' : 'modified', path: paths[paths.length - 1] }
    })
  for (const path of untracked.split('\n').filter(Boolean)) rows.push({ status: 'added', path })
  return rows.sort((a, b) => a.path.localeCompare(b.path))
}
