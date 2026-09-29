import { createServer, type Server as HttpServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { Conversation, Project, RunOptions } from '../../shared/types'
import * as db from './db'
import * as workspace from './workspace'
import * as or from './openrouter'
import * as log from './log'
import * as runs from './runs'
import * as git from './git'
import { readSecret, writeSecret } from './keychain'
import { runningIn } from './run'
import { pendingQuestion, answerQuestion } from './tools/director'
import { pathToLeaf } from './thread'
import { APPROVAL_MESSAGE, DIRECTOR_OPENING, GUIDANCE_FILE, filesOf } from '../../shared/director'
import { DIRECTOR_TIER, parseTiers, tierModel } from '../../shared/tiers'
import {
  ANSWERS_SETTING, ANSWER_MAX, CAP_SETTING, ENABLED_SETTING, NUDGE_MAX, INSTRUCTIONS, PORT_SETTING, RUN_FILE_NAMES, SERVER_NAME, TOKEN_SETTING, TOOLS, WAIT_DEFAULT_S, WAIT_MAX_S,
  allowedHost, allowedOrigin, bearerOf, checkBudget, claudeAddCommand, overseerNote, parseCap, parseReview, parsePort, resolveOne, transcriptText, urlFor, type BridgeStatus, type RunFileName
} from '../../shared/bridge'

/**
 * The bridge: Harbor as an MCP server on the loopback address, so Claude
 * Code can orchestrate and judge director runs. Harbor writes; the person
 * answers the interview and the workers' questions (unless they let Claude
 * answer for them); Claude keeps the run moving and posts its judgement to
 * the person as reviews in the run view. See shared/bridge.ts for the rules.
 *
 * Every tool goes through the same operations the window uses (runs.ts,
 * the turn launcher), so a run is on screen as it happens, in the sidebar
 * with the rest.
 *
 * Off until the person turns it on in Settings. A request needs the token
 * shown there; a browser page cannot reach it (Host and Origin are checked);
 * and a run it starts always has a budget, never over the cap the person
 * set. Only interviews, directors and their workers can be named: ordinary
 * chats are out of its reach.
 */

export interface Deps {
  /** Starts a turn and reports it to the windows; notify tells the person when it ends, for a turn whose answer is theirs to give. */
  launch: (requestId: string, opts: RunOptions, notify?: boolean) => void
  cancel: (requestId: string) => void
  /** The conversation list moved: a run began, a message was sent. */
  changed: () => void
  /** Something the person should know: an interview waiting on them, a review posted. */
  notice: (n: { text: string; conversationId: string; kind: 'interview' | 'review' }) => void
}

let deps: Deps | null = null
let http: HttpServer | null = null
let state: { running: boolean; port: number; error: string | null } = { running: false, port: parsePort(null), error: null }
/** Used when the Keychain cannot hold a token: good until Harbor quits. */
let sessionToken: string | null = null

export function configure(d: Deps): void {
  deps = d
}

const newSecret = (): string => randomBytes(24).toString('base64url')

function token(): string {
  const stored = readSecret(TOKEN_SETTING)
  if (stored) return stored
  const fresh = newSecret()
  try {
    writeSecret(TOKEN_SETTING, fresh)
  } catch {
    sessionToken ??= fresh
    return sessionToken
  }
  return fresh
}

/** A new token; the old one stops working at once. */
export function newToken(): string {
  const fresh = newSecret()
  try {
    writeSecret(TOKEN_SETTING, fresh)
  } catch {
    sessionToken = fresh
  }
  log.info('bridge', 'new token')
  return fresh
}

const sameToken = (given: string): boolean => {
  const a = Buffer.from(given)
  const b = Buffer.from(token())
  return a.length === b.length && timingSafeEqual(a, b)
}

export function status(): BridgeStatus {
  const port = parsePort(db.getSetting(PORT_SETTING))
  return {
    enabled: db.getSetting(ENABLED_SETTING) === '1',
    running: state.running,
    port,
    url: urlFor(port),
    error: state.error,
    cap: parseCap(db.getSetting(CAP_SETTING)),
    answers: answersForPerson(),
    command: claudeAddCommand(port, token())
  }
}

/** Starts or stops the server to match the settings. Safe to call again after any of them change. */
export async function init(): Promise<void> {
  await stop()
  if (db.getSetting(ENABLED_SETTING) !== '1') return
  const port = parsePort(db.getSetting(PORT_SETTING))
  state = { running: false, port, error: null }
  const server = createServer((req, res) => void onRequest(req, res, port))
  // A wait holds its request open for minutes; the defaults would cut it.
  server.requestTimeout = 0
  server.headersTimeout = 60_000
  await new Promise<void>((resolve) => {
    server.once('error', (e: NodeJS.ErrnoException) => {
      state = { running: false, port, error: e.code === 'EADDRINUSE' ? `Port ${port} is taken by another program. Choose another.` : e.message }
      log.warn('bridge', 'could not listen', { port, error: e.message })
      resolve()
    })
    server.listen(port, '127.0.0.1', () => {
      http = server
      state = { running: true, port, error: null }
      log.info('bridge', 'listening', { url: urlFor(port) })
      resolve()
    })
  })
}

export async function stop(): Promise<void> {
  const s = http
  http = null
  state = { ...state, running: false }
  if (!s) return
  s.closeAllConnections()
  await new Promise<void>((resolve) => s.close(() => resolve()))
}

async function onRequest(req: IncomingMessage, res: ServerResponse, port: number): Promise<void> {
  const refuse = (code: number, message: string, extra: Record<string, string> = {}): void => {
    res.writeHead(code, { 'Content-Type': 'application/json', ...extra }).end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }))
  }
  if (!allowedHost(req.headers.host, port) || !allowedOrigin(req.headers.origin)) return refuse(403, 'Not from here.')
  if (new URL(req.url ?? '/', 'http://127.0.0.1').pathname !== '/mcp') return refuse(404, 'The endpoint is /mcp.')
  const given = bearerOf(req.headers.authorization)
  if (!given || !sameToken(given)) {
    log.warn('bridge', 'refused a request without the token')
    return refuse(401, "Harbor's bridge token is missing or wrong. Copy the command from Harbor's Settings, under Integrations.", { 'WWW-Authenticate': 'Bearer' })
  }
  // Stateless: no session to stream to, so nothing to GET or DELETE.
  if (req.method !== 'POST') return refuse(405, 'POST only.', { Allow: 'POST' })
  let body: unknown
  try {
    body = JSON.parse(await readBody(req))
  } catch (e) {
    return refuse(400, (e as Error).message || 'Not JSON.')
  }
  const server = buildServer()
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
  res.on('close', () => {
    void transport.close()
    void server.close()
  })
  try {
    await server.connect(transport)
    await transport.handleRequest(req, res, body)
  } catch (e) {
    log.error('bridge', 'request failed', { error: (e as Error).message })
    if (!res.headersSent) refuse(500, (e as Error).message)
  }
}

const BODY_MAX = 1_000_000
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0
    const parts: Buffer[] = []
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > BODY_MAX) {
        reject(new Error('The request is too large.'))
        req.destroy()
      } else parts.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')))
    req.on('error', reject)
  })
}

function buildServer(): Server {
  const server = new Server({ name: SERVER_NAME, version: '1.0.0' }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, annotations: { readOnlyHint: t.readOnly } }))
  }))
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name
    const args = (req.params.arguments ?? {}) as Record<string, unknown>
    const started = Date.now()
    try {
      const result = await call(name, args)
      log.info('bridge', name, { ms: Date.now() - started })
      return { content: [{ type: 'text' as const, text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }] }
    } catch (e) {
      log.warn('bridge', `${name} refused`, { error: (e as Error).message })
      return { content: [{ type: 'text' as const, text: (e as Error).message }], isError: true }
    }
  })
  return server
}

/* The tools. Each is small; the work is in runs.ts and the turn loop. */

export async function call(name: string, a: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'list_projects':
      return projects().map((p) => ({ id: p.id, name: p.name, folder: p.rootPath }))
    case 'list_runs': {
      const project = projectOf(a.project)
      return db
        .listConversations()
        .filter((c) => c.projectId === project.id && (c.role === 'director' || c.role === 'interview') && !c.scratch)
        .sort((x, y) => y.createdAt - x.createdAt)
        .map((c) => ({
          id: c.id,
          role: c.role,
          title: c.title,
          runFolder: c.runDir,
          ...(c.role === 'director' ? { approved: c.approved, budget: c.budget, spent: round(db.runCost(c.id)), branch: c.runBranch } : {}),
          running: busy(c),
          archived: c.archived,
          createdAt: new Date(c.createdAt).toISOString()
        }))
    }
    case 'start_interview': {
      const project = projectOf(a.project)
      const text = overseerNote(textOf(a.message, 'message'), ANSWER_MAX, 'answer')
      const model = await modelFor(typeof a.model === 'string' && a.model.trim() ? a.model.trim() : project.defaultModel || lastModel())
      const conv = runs.createInterview(project.id, model, 'Interview (Claude)')
      const mine = answersForPerson()
      // The person is told when the interviewer's first questions are ready, since the answers are theirs.
      await send(conv, text, !mine)
      if (!mine) deps?.notice({ text: `Claude started an interview in ${project.name}. It needs your answers.`, conversationId: conv.id, kind: 'interview' })
      return {
        interview: conv.id,
        runFolder: conv.runDir,
        answeredBy: mine ? 'you, for the person' : 'the person, in Harbor',
        next: mine
          ? 'Call wait on the interview, read its questions with read_conversation, and relay the person\'s answers with send_message.'
          : 'Tell the person the interview is waiting for them in Harbor. Call wait on it; it returns when the requirements are written.'
      }
    }
    case 'start_director': {
      const project = projectOf(a.project)
      const budget = checkBudget(a.budget, parseCap(db.getSetting(CAP_SETTING)))
      // The requirements are Harbor's interviewer's to write, never the overseer's.
      const fromId = typeof a.from_interview === 'string' ? a.from_interview.trim() : ''
      if (!fromId) throw new Error("A director plans from an interview's requirements: start_interview first, and give its id as from_interview once run_status says requirementsWritten.")
      const interview = conversationOf(fromId, ['interview'])
      if (interview.projectId !== project.id) throw new Error('That interview belongs to another project.')
      if (busy(interview)) throw new Error('The interview is still working; wait for it first.')
      const written = await readIn(project, filesOf(interview.runDir).requirements)
      if (!written?.trim()) throw new Error(`The interview has not written ${filesOf(interview.runDir).requirements} yet. ${answersForPerson() ? "Relay the person's answers to its questions until it does." : 'The person is answering it in Harbor; wait on it.'}`)
      if (!project.rootPath || !(await workspace.isRepo(project.rootPath))) {
        throw new Error("A director needs its project folder under git: its workers run commands without asking, which is safe only where every change can be seen and undone.")
      }
      const model = await modelFor(typeof a.model === 'string' && a.model.trim() ? a.model.trim() : tierModel(parseTiers(project.tiers), DIRECTOR_TIER, project.defaultModel || lastModel()))
      const rehearsal = a.rehearsal === true
      const conv = await runs.startDirector(project.id, model, budget, rehearsal, interview.id, rehearsal ? 'Director (Claude, rehearsal)' : 'Director (Claude)')
      await send(conv, DIRECTOR_OPENING)
      log.info('bridge', 'director started', { project: project.name, model, budget, rehearsal })
      return {
        director: conv.id,
        runFolder: conv.runDir,
        branch: conv.runBranch,
        budget,
        model,
        next: 'Call wait on the director. When its turn ends, read requirements, design and tasks with read_run_file; approve_plan if the plan meets the requirements, or post_review with what it misses and tell the person.'
      }
    }
    case 'send_message': {
      const conv = conversationOf(a.conversation, ['interview', 'director'])
      const text = textOf(a.text, 'text')
      if (conv.role === 'interview') {
        if (!answersForPerson()) throw new Error("The person answers this interview in Harbor, and has not let you answer for them. wait on it: it returns when the requirements are written.")
        await send(conv, overseerNote(text, ANSWER_MAX, 'answer'))
      } else await send(conv, overseerNote(text, NUDGE_MAX))
      return { sent: true, next: 'Call wait on the same conversation.' }
    }
    case 'approve_plan': {
      const conv = conversationOf(a.director, ['director'])
      if (conv.approved) throw new Error('This plan is already approved.')
      if (busy(conv)) throw new Error('The director is still working; wait for it first.')
      const project = projectFor(conv)
      const files = filesOf(conv.runDir)
      const [design, tasks] = await Promise.all([readIn(project, files.design), readIn(project, files.tasks)])
      if (!design?.trim() || !tasks?.trim()) throw new Error(`There is no plan to approve yet: ${files.design} and ${files.tasks} must both be written.`)
      db.approveConversation(conv.id)
      log.info('bridge', 'plan approved by the overseer', { director: conv.id.slice(0, 8) })
      await send(db.getConversation(conv.id) ?? conv, APPROVAL_MESSAGE)
      return { approved: true, next: 'The director is dispatching workers. Call wait; it returns when a worker asks a question or the director finishes its turn.' }
    }
    case 'answer_question': {
      const worker = conversationOf(a.worker, ['worker'])
      if (!answersForPerson()) throw new Error("The person answers workers' questions in Harbor, and has not let you answer for them.")
      const answer = overseerNote(textOf(a.answer, 'answer'), ANSWER_MAX, 'answer')
      if (!pendingQuestion(worker.id)) throw new Error('That worker is not waiting on a question.')
      db.addMessage(worker.id, worker.leafId, 'user', answer, null)
      answerQuestion(worker.id, answer)
      deps?.changed()
      return { answered: true }
    }
    case 'post_review': {
      const conv = conversationOf(a.director, ['director'])
      const review = db.addReview(conv.id, parseReview(a))
      log.info('bridge', 'review posted', { director: conv.id.slice(0, 8), verdict: review.verdict, suggestions: review.suggestions.length })
      deps?.notice({ text: `Claude reviewed ${conv.title}: ${review.verdict}${review.suggestions.length ? `, ${review.suggestions.length} suggestion${review.suggestions.length === 1 ? '' : 's'}` : ''}.`, conversationId: conv.id, kind: 'review' })
      return { posted: review.id, next: 'It is in the run view for the person. Tell them in your reply what you found.' }
    }
    case 'run_status':
      return snapshot(conversationOf(a.conversation, ['interview', 'director']))
    case 'wait': {
      const conv = conversationOf(a.conversation, ['interview', 'director', 'worker'])
      const seconds = Math.max(1, Math.min(WAIT_MAX_S, Number(a.seconds) || WAIT_DEFAULT_S))
      const until = Date.now() + seconds * 1000
      const mine = answersForPerson()
      for (;;) {
        const fresh = db.getConversation(conv.id) ?? conv
        if (fresh.role === 'interview' && !mine) {
          // The person is answering it; the interview is done for Claude when its requirements are.
          if (!busy(fresh) && (await requirementsOf(fresh))) return { reason: 'requirements written', ...(await snapshot(fresh)) }
          if (Date.now() >= until) return { reason: busy(fresh) ? 'still running' : 'waiting on the person', ...(await snapshot(fresh)) }
        } else {
          if (mine && questionsOf(fresh).length > 0) return { reason: 'question', ...(await snapshot(fresh)) }
          if (!busy(fresh)) return { reason: 'idle', ...(await snapshot(fresh)) }
          if (Date.now() >= until) return { reason: 'still running', ...(await snapshot(fresh)) }
        }
        await new Promise((r) => setTimeout(r, 1000))
      }
    }
    case 'read_conversation': {
      const conv = conversationOf(a.conversation, ['interview', 'director', 'worker'])
      const path = pathToLeaf(db.listMessages(conv.id), conv.leafId).filter((m) => m.role !== 'tool')
      return transcriptText(path, Number(a.last))
    }
    case 'read_run_file': {
      const conv = conversationOf(a.conversation, ['interview', 'director'])
      const file = String(a.file ?? '') as RunFileName
      if (!RUN_FILE_NAMES.includes(file)) throw new Error(`file is one of ${RUN_FILE_NAMES.join(', ')}.`)
      const files = filesOf(conv.runDir)
      const path = file === 'guidance' ? GUIDANCE_FILE : files[file]
      if (!path) throw new Error('A run from before run folders has no log file of its own.')
      const text = await readIn(projectFor(conv), path)
      return text === null ? `${path} has not been written yet.` : `# ${path}\n\n${text}`
    }
    case 'run_changes': {
      const conv = conversationOf(a.director, ['director'])
      const project = projectFor(conv)
      if (!conv.runBase) throw new Error("This run recorded no commit to compare with: its folder is not under git, or it began before runs recorded one.")
      const changes = await git.changesSince(project.rootPath as string, conv.runBase)
      return { base: conv.runBase, branch: conv.runBranch, changes }
    }
    case 'read_file': {
      const conv = conversationOf(a.conversation, ['interview', 'director', 'worker'])
      const project = projectFor(conv)
      const path = textOf(a.path, 'path')
      // Through the jail, as the agents read: inside the folder, nothing it keeps locked.
      return workspace.readFile(project.rootPath as string, path, Math.max(0, Number(a.offset) || 0), Math.max(0, Number(a.limit) || 0), project.unlocked)
    }
    case 'stop': {
      const conv = conversationOf(a.conversation, ['interview', 'director', 'worker'])
      const requests = [conv, ...(conv.role === 'director' ? db.listWorkers(conv.id) : [])].flatMap((c) => runningIn(c.id))
      for (const r of requests) deps?.cancel(r)
      log.info('bridge', 'stopped', { conversation: conv.id.slice(0, 8), turns: requests.length })
      return { stopped: requests.length }
    }
    case 'finish_run': {
      const conv = conversationOf(a.director, ['director'])
      if (busy(conv)) throw new Error('The run is still working; wait for it, or stop it first.')
      const done = await runs.finishRun(conv.id)
      deps?.changed()
      return { log: done.path, workersArchived: done.workers }
    }
    default:
      throw new Error(`Harbor has no tool called ${name}.`)
  }
}

const round = (n: number): number => Math.round(n * 10_000) / 10_000

const projects = (): Project[] => db.listProjects().filter((p) => !p.archived && !!p.rootPath)
function projectOf(query: unknown): Project {
  return resolveOne(projects(), query, 'project')
}
function projectFor(conv: Conversation): Project {
  const p = db.getProject(conv.projectId)
  if (!p?.rootPath) throw new Error('That run\'s project has no folder.')
  return p
}

/* Only a run's conversations can be named: an interview, a director, a worker. A chat is not the bridge's to read. */
function conversationOf(query: unknown, roles: Conversation['role'][]): Conversation {
  const live = new Set(projects().map((p) => p.id))
  const pool = db.listConversations().filter((c) => roles.includes(c.role) && live.has(c.projectId))
  return resolveOne(pool, query, roles.join(' or '))
}

function textOf(v: unknown, what: string): string {
  const t = typeof v === 'string' ? v.trim() : ''
  if (!t) throw new Error(`${what} is empty.`)
  return t
}

const readIn = (p: Project, path: string): Promise<string | null> => workspace.readRaw(p.rootPath as string, path, p.unlocked).catch(() => null)

const lastModel = (): string => db.getSetting('last_model') ?? ''
/** The person lets Claude answer the interview and workers' questions for them. Off unless they said so. */
const answersForPerson = (): boolean => db.getSetting(ANSWERS_SETTING) === '1'
const requirementsOf = async (conv: Conversation): Promise<boolean> => !!(await readIn(projectFor(conv), filesOf(conv.runDir).requirements))?.trim()

/* The model has to exist and call tools; a director that cannot call them cannot write a file. */
async function modelFor(id: string): Promise<string> {
  if (!id) throw new Error('No model given, and Harbor has none remembered. Name one.')
  const info = await or.modelOf(id)
  if (!info) throw new Error(`Harbor's model list has no ${id}.`)
  if (!info.supportsTools && !or.isLocalModel(id)) throw new Error(`${id} cannot call tools, and a run's agents need them.`)
  return id
}

/** A conversation or any of its workers has a turn running. */
function busy(conv: Conversation): boolean {
  if (runningIn(conv.id).length > 0) return true
  return conv.role === 'director' && db.listWorkers(conv.id).some((w) => runningIn(w.id).length > 0)
}

function questionsOf(conv: Conversation): { worker: string; title: string; question: string }[] {
  if (conv.role === 'worker') {
    const q = pendingQuestion(conv.id)
    return q ? [{ worker: conv.id, title: conv.title, question: q }] : []
  }
  if (conv.role !== 'director') return []
  return db.listWorkers(conv.id).flatMap((w) => {
    const q = pendingQuestion(w.id)
    return q ? [{ worker: w.id, title: w.title, question: q }] : []
  })
}

/* A message from Claude, stored where the person's would be, and the turn started as the window starts one. */
async function send(conv: Conversation, text: string, notify = false): Promise<void> {
  if (!deps) throw new Error('Harbor is still starting.')
  if (busy(conv)) throw new Error('A turn is already running there; wait for it first.')
  const fresh = db.getConversation(conv.id) ?? conv
  const model = fresh.model ?? lastModel()
  if (!model) throw new Error('The conversation has no model.')
  const info = await or.modelOf(model)
  const msg = db.addMessage(fresh.id, fresh.leafId, 'user', text, null)
  deps.launch(randomUUID(), {
    conversationId: fresh.id,
    parentId: msg.id,
    model,
    agent: true,
    web: false,
    // A model that always reasons must be asked to; the request fails otherwise.
    reasoning: info?.reasoning?.mandatory === true,
    plan: false,
    params: {},
    accepts: info?.inputModalities ?? ['text'],
    contextLength: info?.contextLength ?? (await or.contextLengthOf(model))
  }, notify)
  deps.changed()
}

async function snapshot(conv: Conversation): Promise<Record<string, unknown>> {
  const project = projectFor(conv)
  const files = filesOf(conv.runDir)
  const path = pathToLeaf(db.listMessages(conv.id), conv.leafId)
  const reply = [...path].reverse().find((m) => m.role === 'assistant' && m.content.trim())
  const base: Record<string, unknown> = {
    id: conv.id,
    role: conv.role,
    title: conv.title,
    project: project.name,
    folder: project.rootPath,
    runFolder: conv.runDir ?? files.dir,
    running: busy(conv),
    latestReply: reply ? (reply.content.length > 4000 ? `${reply.content.slice(0, 4000)}\n… (read_conversation has the rest)` : reply.content) : null,
    lastError: [...path].reverse().find((m) => m.role === 'assistant')?.error ?? null
  }
  if (conv.role === 'interview') {
    const req = await readIn(project, files.requirements)
    return { ...base, requirementsWritten: !!req?.trim(), requirementsFile: files.requirements, answeredBy: answersForPerson() ? 'you, for the person' : 'the person, in Harbor' }
  }
  if (conv.role !== 'director') return base
  const st = runs.statusOf(conv.id)
  const board = await runs.boardOf(conv.id)
  return {
    ...base,
    approved: conv.approved,
    rehearsal: conv.rehearsal,
    budget: st?.budget ?? conv.budget,
    spent: round(st?.spent ?? 0),
    left: round(Math.max(0, (st?.budget ?? 0) - (st?.spent ?? 0))),
    branch: st?.branch ?? null,
    base: st?.base ?? null,
    files: { requirements: files.requirements, design: files.design, tasks: files.tasks, handoff: files.handoff },
    board: board.map((t) => ({ id: t.id, title: t.title, status: t.status })),
    workers: runs.workersOf(conv.id).map((w) => ({ id: w.id, task: w.taskId, title: w.title, attempt: w.attempt, model: w.model, running: runningIn(w.id).length > 0, stopped: w.stopped, cost: round(w.cost), lastLine: w.lastLine, archived: w.archived })),
    questions: questionsOf(conv),
    questionsAnsweredBy: answersForPerson() ? 'you, for the person' : 'the person, in Harbor',
    reviews: db.listReviews(conv.id).slice(0, 5).map((r) => ({ id: r.id, verdict: r.verdict, at: new Date(r.createdAt).toISOString(), summary: r.summary, suggestions: r.suggestions.map((x) => ({ text: x.text, task: x.task, state: x.state })) }))
  }
}
