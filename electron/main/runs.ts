import { realpath } from 'node:fs/promises'
import * as db from './db'
import * as workspace from './workspace'
import * as git from './git'
import * as log from './log'
import type { Conversation } from '../../shared/types'
import { DEFAULT_GUIDANCE, GUIDANCE_FILE, LEGACY_RUN, filesOf, parseTasks, ARCHIVED_ON_START, archiveDirFor, renderRunLog, runDirFor, runFiles, runLogFile, taskIdOf, type RunWorker, type Task } from '../../shared/director'

/**
 * A director run's operations, whoever asks: the window through IPC, or
 * Claude through the bridge. Starting one on its own branch in its own
 * folder, an interview to write its requirements, its board and workers,
 * and the log written when it finishes.
 */

/* An interview begins a run: the folder its requirements go in, and the one its director will read. */
export function createInterview(projectId: string, model: string | null, title?: string): Conversation {
  const c = db.createConversation(projectId, model, false, 'interview', title ? { title } : {})
  db.setRunDir(c.id, runDirFor(c.createdAt, c.id))
  return db.getConversation(c.id) ?? c
}

/* A director run: its conversation, its budget, and the guidance file it briefs by. */
export async function startDirector(projectId: string, model: string, budget: number, rehearsal?: boolean, fromInterview?: string | null, title?: string): Promise<Conversation> {
  const project = db.getProject(projectId)
  if (!project?.rootPath) throw new Error('A director needs a project with a folder.')
  const conv = db.createConversation(projectId, model, false, 'director', { budget: Math.max(0, Number(budget) || 0), rehearsal: !!rehearsal, title: title ?? (rehearsal ? 'Director (rehearsal)' : undefined) })
  /*
    Where the run works. A branch of its own makes the whole run one diff to
    merge or throw away — but only when the project folder is the
    repository itself and the tree is clean; a folder inside a bigger
    repository, or a tree with other work in it, keeps its branch and the
    run records the commit it started from instead.
  */
  const top = await git.repoRoot(project.rootPath)
  // A folder the repository ignores has no history and no diff; the run is told it is not under version control.
  const ignored = top ? await git.isIgnored(project.rootPath) : false
  if (ignored) log.warn('director', 'the project folder is ignored by its repository; no diff will exist for this run', { folder: project.rootPath })
  const base = top && !ignored ? await git.headSha(project.rootPath) : null
  let branch: string | null = null
  const same = top ? (await Promise.all([realpath(top), realpath(project.rootPath)]).then(([a, b]) => a === b).catch(() => false)) : false
  if (top && !ignored && same && (await git.isClean(project.rootPath))) {
    branch = await git.createBranch(project.rootPath, git.runBranchName(project.name, Date.now())).catch(() => null)
  }
  /*
    The run's folder is its interview's: the requirements it wrote are the
    ones this director plans from, and nobody else's. A director started
    without an interview gets a folder of its own, empty, and its prompt
    tells it to stop when the requirements are missing.

    A project from before folders may still have a run's files at the top
    of _director/. The requirements move into this run's folder when it
    has none of its own (they were the ones the person meant, since there
    was only ever one); the old design, board and handoff go to a dated
    archive where they can still be read.
  */
  const interview = fromInterview ? db.getConversation(fromInterview) : null
  const runDir = interview?.projectId === projectId && interview.runDir ? interview.runDir : runDirFor(Date.now(), conv.id)
  const files = runFiles(runDir)
  const legacyRequirements = await workspace.readRaw(project.rootPath, LEGACY_RUN.requirements, project.unlocked).catch(() => null)
  const ownRequirements = await workspace.readRaw(project.rootPath, files.requirements, project.unlocked).catch(() => null)
  if (legacyRequirements !== null && ownRequirements === null) {
    await workspace.writeRaw(project.rootPath, files.requirements, legacyRequirements, project.unlocked)
    log.info('director', 'requirements from before run folders moved into the run', { run: runDir })
  }
  const archive = archiveDirFor(Date.now())
  for (const path of ARCHIVED_ON_START) {
    const old = await workspace.readRaw(project.rootPath, path, project.unlocked).catch(() => null)
    if (old === null) continue
    await workspace.writeRaw(project.rootPath, `${archive}-before-folders/${path.split('/').pop()}`, old, project.unlocked)
    await workspace.deleteRaw(project.rootPath, path, project.unlocked)
  }
  db.setRunDir(conv.id, runDir)
  const existing = await workspace.readRaw(project.rootPath, GUIDANCE_FILE, project.unlocked).catch(() => null)
  if (existing === null) await workspace.writeRaw(project.rootPath, GUIDANCE_FILE, DEFAULT_GUIDANCE, project.unlocked)
  db.setRunGit(conv.id, branch, base)
  log.info('director', 'run started', { project: project.name, model, budget, branch, base, run: runDir, fromInterview: !!interview })
  return db.getConversation(conv.id) ?? conv
}

/*
  Finishing a run: a log of what happened, written from the record, then
  the workers put away. The log holds every report verbatim, so the
  conversations it summarises can be archived without losing anything a
  person would come back for; they stay searchable.
*/
export async function finishRun(id: string): Promise<{ path: string; workers: number }> {
  const director = db.getConversation(id)
  if (!director || director.role !== 'director') throw new Error('Not a director.')
  const project = db.getProject(director.projectId)
  if (!project?.rootPath) throw new Error('The project has no folder.')
  const projects = db.listProjects()
  const workers = db.listWorkers(id).map((w) => {
    const messages = db.listMessages(w.id)
    const said = messages.filter((m) => m.role === 'assistant' && m.content.trim())
    const last = said[said.length - 1]
    const stopped = last?.content.startsWith('STOPPED:') ? last.content.slice('STOPPED:'.length).trim() : null
    const report = stopped ? (said[said.length - 2]?.content ?? '') : (last?.content ?? '')
    const title = w.title.split(' — ')
    const attempt = db.listWorkers(id).filter((o) => taskIdOf(o.title) === taskIdOf(w.title) && o.createdAt <= w.createdAt).length
    return {
      taskId: taskIdOf(w.title),
      title: title.slice(1).join(' — ') || w.title,
      attempt,
      model: w.model ?? '',
      home: projects.find((p) => p.id === w.projectId)?.name ?? '',
      startedAt: w.createdAt,
      endedAt: w.updatedAt,
      cost: db.conversationCost(w.id),
      steps: messages.filter((m) => m.role === 'assistant').length,
      report,
      stopped,
      errors: messages.filter((m) => m.error).map((m) => m.error as string)
    }
  })
  const dmsgs = db.listMessages(id)
  const handoffMsg = [...dmsgs].reverse().find((m) => m.role === 'assistant' && m.content.trim())
  const board = (await workspace.readRaw(project.rootPath, filesOf(director.runDir).tasks, project.unlocked).catch(() => null)) ?? ''
  const text = renderRunLog({
    project: project.name,
    model: director.model ?? '',
    budget: director.budget,
    startedAt: director.createdAt,
    finishedAt: Date.now(),
    directorCost: db.conversationCost(id),
    directorSteps: dmsgs.filter((m) => m.role === 'assistant').length,
    workers,
    board,
    handoff: handoffMsg?.content ?? ''
  })
  const path = runLogFile(director.createdAt, director.runDir)
  await workspace.writeRaw(project.rootPath, path, text, project.unlocked)
  for (const w of db.listWorkers(id)) db.setArchived(w.id, true)
  log.info('director', 'run finished', { workers: workers.length, log: path })
  return { path, workers: workers.length }
}

/** Each worker a run sent out, with its last line and what it cost. */
export function workersOf(id: string): RunWorker[] {
  const projects = db.listProjects()
  const all = db.listWorkers(id)
  return all.map((w) => {
    const messages = db.listMessages(w.id)
    const said = [...messages].reverse().find((m) => (m.role === 'assistant' || m.role === 'tool') && m.content.trim())
    const attempt = all.filter((o) => taskIdOf(o.title) === taskIdOf(w.title) && o.createdAt <= w.createdAt).length
    const last = said?.content.trim().split('\n').filter(Boolean).pop() ?? ''
    return {
      id: w.id,
      taskId: taskIdOf(w.title),
      title: w.title.split(' — ').slice(1).join(' — ') || w.title,
      attempt,
      model: w.model ?? '',
      home: projects.find((p) => p.id === w.projectId)?.name ?? '',
      cost: db.conversationCost(w.id),
      steps: messages.filter((m) => m.role === 'assistant').length,
      createdAt: w.createdAt,
      updatedAt: w.updatedAt,
      lastLine: last.length > 160 ? `${last.slice(0, 159)}…` : last,
      stopped: said?.content.startsWith('STOPPED:') ?? false,
      archived: w.archived
    }
  })
}

export function statusOf(id: string): { budget: number; approved: boolean; spent: number; branch: string | null; base: string | null } | null {
  const c = db.getConversation(id)
  return c ? { budget: c.budget, approved: c.approved, spent: db.runCost(id), branch: c.runBranch, base: c.runBase } : null
}

/** The run's task board, read from its folder; empty before the director has written one. */
export async function boardOf(id: string): Promise<Task[]> {
  const c = db.getConversation(id)
  const project = c ? db.getProject(c.projectId) : null
  if (!c || !project?.rootPath) return []
  const text = await workspace.readRaw(project.rootPath, filesOf(c.runDir).tasks, project.unlocked).catch(() => null)
  return text ? parseTasks(text) : []
}
