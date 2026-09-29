import type { TodoItem } from '../../../shared/types'
import * as workspace from '../workspace'
import { isSpillPath, readSpilled } from '../spill'
import * as skills from '../skills'
import * as knowledge from '../knowledge'
import { writeWithCheckpoint } from '../checkpoints'
import { withinWriteGlobs } from '../../../shared/globs'
import { ASK_ORACLE, COMMAND_OUTPUT, FILE_TOOLS, FIND_TOOLS, LOAD_SKILL, SEARCH_KNOWLEDGE, STOP_COMMAND } from './schemas'
import { ORACLE_TIER, parseTiers, tierModel } from '../../../shared/tiers'
import * as mcp from '../mcp'
import { formatListing, rankTools, splitToolName, summariseArgs } from '../../../shared/mcp'
import type { Tool } from './registry'
import type { ToolContext } from './context'
import type { Turn } from '../turn'
import { randomUUID } from 'node:crypto'
import * as db from '../db'
import * as or from '../openrouter'
import * as log from '../log'
import * as commands from '../commands'
import { runHooks } from '../hooks'
import { autoApproveHeld, autoApproves } from '../../../shared/approval'
import * as sandbox from '../sandbox'
import * as judge from '../judge'
import { CONSECUTIVE_DENIALS, TOTAL_DENIALS, isSafeCommand } from '../../../shared/judge'

/**
 * The tools every agent turn has: the project folder through the jail, the
 * shell behind approval, skills, knowledge and the checklist.
 */

const schemaFor = (name: string): Tool['schema'] => {
  const found = (FILE_TOOLS as unknown as Tool['schema'][]).find((s) => s.function.name === name)
  if (!found) throw new Error(`No schema for ${name}`)
  return found
}

/** The project's write allowance, where it has one. Said in words, since the model will read it. */
export function refuseOutside(ctx: ToolContext, path: unknown): void {
  const p = String(path ?? '')
  const frozen = ctx.frozen?.(p)
  if (frozen) throw new Error(frozen)
  if (withinWriteGlobs(p, ctx.writeGlobs)) return
  // A director behind the gate may write its plan and nothing else, and the gate is a button, not a word.
  if (ctx.gated) {
    throw new Error(
      `${p} is not the design, the board or the guidance, which are all that may be written before the plan is approved (${ctx.writeGlobs.join(', ')}). Approval is the "Approve plan" button in the header; the person saying "approved" in the chat does not open it. If they have said so, ask them to press the button, then carry on — the gate opens on your next step.`
    )
  }
  throw new Error(
    `${p} is outside where this project lets the agent write (${ctx.writeGlobs.join(', ')}). Write inside those paths, or ask the person to widen them.`
  )
}

/**
 * The line most like the first line of a string that was not found, so the
 * model can correct its edit without re-reading the whole file.
 */
export function nearestLine(text: string, wanted: string): { line: number; text: string } | null {
  const probe = wanted.split('\n').map((l) => l.trim()).find((l) => l.length > 0)
  if (!probe) return null
  const lines = text.split('\n')
  let best: { line: number; text: string; score: number } | null = null
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim()
    if (!t) continue
    let score = 0
    if (t.includes(probe) || probe.includes(t)) score = Math.min(t.length, probe.length)
    else {
      // Shared leading run, then shared words.
      let k = 0
      while (k < t.length && k < probe.length && t[k] === probe[k]) k++
      const words = new Set(probe.split(/\W+/).filter((w) => w.length > 2))
      const shared = t.split(/\W+/).filter((w) => words.has(w)).length
      score = k + shared * 4
    }
    if (score > 8 && (!best || score > best.score)) best = { line: i + 1, text: t.slice(0, 160), score }
  }
  return best ? { line: best.line, text: best.text } : null
}

/* What the hooks said, under the write they followed, so the model reads both. */
const withHooks = (done: string, hooks: string): string => (hooks ? `${done}\n\n${hooks}` : done)

const readFile: Tool = {
  schema: schemaFor('read_file'),
  needs: 'workspace',
  writes: false,
  director: true,
  interview: true,
  subject: (a) => String(a.path ?? ''),
  execute: (ctx, args) =>
    // A saved tool result is Harbor's own file, outside the project; it is the one place read_file reaches beyond the jail.
    isSpillPath(String(args.path ?? ''))
      ? readSpilled(String(args.path), args.offset ?? 0, args.limit ?? 0)
      : workspace.readFile(ctx.root, args.path, args.offset ?? 0, args.limit ?? 0, ctx.unlocked)
}

const listDir: Tool = {
  schema: schemaFor('list_dir'),
  needs: 'workspace',
  writes: false,
  director: true,
  interview: true,
  subject: (a) => String(a.path ?? '.'),
  execute: (ctx, args) => workspace.listDir(ctx.root, args.path ?? '.', ctx.unlocked)
}

const search: Tool = {
  schema: schemaFor('search'),
  needs: 'workspace',
  writes: false,
  director: true,
  interview: true,
  subject: (a) => String(a.query ?? ''),
  execute: (ctx, args) =>
    workspace.search(ctx.root, args.query, { kind: args.kind, glob: args.glob, unlocked: ctx.unlocked })
}

const writeFile: Tool = {
  schema: schemaFor('write_file'),
  needs: 'workspace',
  writes: true,
  director: true,
  interview: true,
  subject: (a) => String(a.path ?? ''),
  execute: async (ctx, args) => {
    refuseOutside(ctx, args.path)
    await writeWithCheckpoint(ctx.root, ctx.runId, ctx.conversationId, args.path, args.content, ctx.unlocked, ctx.webUsed())
    ctx.onWrote(args.path)
    return withHooks(`Wrote ${args.path}.`, await ctx.afterWrite(args.path))
  }
}

const editFile: Tool = {
  schema: schemaFor('edit_file'),
  needs: 'workspace',
  writes: true,
  director: true,
  interview: true,
  subject: (a) => String(a.path ?? ''),
  execute: async (ctx, args) => {
    refuseOutside(ctx, args.path)
    const current = await workspace.readRaw(ctx.root, args.path, ctx.unlocked)
    if (current === null) {
      throw new Error(`${args.path} does not exist. Use write_file to create it.`)
    }
    const occurrences = current.split(args.old_string).length - 1
    if (occurrences === 0) {
      const near = nearestLine(current, args.old_string)
      throw new Error(
        `That exact text is not in ${args.path}.${near ? ` The closest line is ${near.line}: ${near.text}` : ''} Read the file and try again.`
      )
    }
    if (occurrences > 1 && !args.replace_all) {
      throw new Error(
        `That text appears ${occurrences} times in ${args.path}. Include more context to make it unique, or set replace_all.`
      )
    }
    // A function replacer, or "$&" and "$'" in the new text would be read
    // as substitution patterns and the file would say something else.
    const next = args.replace_all
      ? current.split(args.old_string).join(args.new_string)
      : current.replace(args.old_string, () => args.new_string)
    await writeWithCheckpoint(ctx.root, ctx.runId, ctx.conversationId, args.path, next, ctx.unlocked, ctx.webUsed())
    ctx.onWrote(args.path)
    return withHooks(
      `Edited ${args.path}${args.replace_all ? ` (${occurrences} occurrences)` : ''}.`,
      await ctx.afterWrite(args.path)
    )
  }
}

const runCommand: Tool = {
  schema: schemaFor('run_command'),
  needs: 'workspace',
  writes: true,
  director: true,
  subject: (a) => String(a.command ?? ''),
  execute: (ctx, args) => ctx.runCommand(args.command, args.timeout_seconds, args.unsandboxed === true, args.background === true)
}

const commandOutput: Tool = {
  schema: COMMAND_OUTPUT as Tool['schema'],
  needs: 'workspace',
  writes: false,
  director: true,
  subject: (a) => String(a.handle ?? '').slice(0, 8),
  execute: (ctx, args) =>
    ctx.commandOutput(String(args.handle ?? ''), typeof args.wait_for === 'string' && args.wait_for.trim() ? args.wait_for : null, typeof args.timeout_seconds === 'number' ? args.timeout_seconds : 60)
}

const stopCommand: Tool = {
  schema: STOP_COMMAND as Tool['schema'],
  needs: 'workspace',
  writes: false,
  director: true,
  subject: (a) => String(a.handle ?? '').slice(0, 8),
  execute: (ctx, args) => ctx.stopCommand(String(args.handle ?? ''))
}
/** Reading and ending what run_command started in the background. */
export const JOBS: Tool[] = [commandOutput, stopCommand]

const todoWrite: Tool = {
  schema: schemaFor('todo_write'),
  needs: 'workspace',
  writes: false,
  director: true,
  subject: (a) => `${(a.todos as unknown[] | undefined)?.length ?? 0} items`,
  execute: async (ctx, args) => {
    const items = (args.todos ?? []) as TodoItem[]
    ctx.onTodos(items)
    return `Checklist updated: ${items.filter((t) => t.status === 'done').length} of ${items.length} done.`
  }
}

const loadSkill: Tool = {
  schema: LOAD_SKILL as Tool['schema'],
  needs: 'skills',
  writes: false,
  director: true,
  interview: true,
  subject: (a) => String(a.name ?? ''),
  execute: async (ctx, args) => {
    const skill = await skills.get(ctx.projectId, String(args.name), ctx.root || null)
    if (!skill) throw new Error(`There is no skill called ${args.name}.`)
    return skills.describe(skill)
  }
}

const searchKnowledge: Tool = {
  schema: SEARCH_KNOWLEDGE as Tool['schema'],
  needs: 'knowledge',
  writes: false,
  director: true,
  interview: true,
  subject: (a) => String(a.query ?? ''),
  execute: async (ctx, args) => {
    if (!ctx.projectId) throw new Error('This conversation has no project.')
    const hits = await knowledge.search(ctx.projectId, String(args.query), args.k ?? 6)
    return knowledge.formatHits(hits)
  }
}

/** In the order the model is shown them, which the prompt cache also sees. */
export const FILE: Tool[] = (FILE_TOOLS as unknown as Tool['schema'][]).map((s) => {
  const byName: Record<string, Tool> = { read_file: readFile, list_dir: listDir, search, write_file: writeFile, edit_file: editFile, run_command: runCommand, todo_write: todoWrite }
  const t = byName[s.function.name]
  if (!t) throw new Error(`No tool for schema ${s.function.name}`)
  return t
})
export const KNOWLEDGE: Tool[] = [loadSkill, searchKnowledge]

const askOracle: Tool = {
  schema: ASK_ORACLE as Tool['schema'],
  writes: false,
  director: true,
  interview: true,
  subject: (a) => String(a.question ?? '').slice(0, 80),
  execute: (ctx, args) => {
    const question = String(args.question ?? '').trim()
    if (!question) throw new Error('Ask something.')
    return ctx.askOracle(question, typeof args.material === 'string' ? args.material : '')
  }
}
/** A second opinion, from whatever model the project names as its oracle. */
export const ORACLE: Tool[] = [askOracle]

const findTools: Tool = {
  schema: FIND_TOOLS as Tool['schema'],
  writes: false,
  director: true,
  subject: (a) => String(a.query ?? ''),
  execute: (ctx, args) => ctx.findTools(String(args.query ?? ''))
}
/** Offered only while a server is connected; see index.ts. */
export const DISCOVERY: Tool[] = [findTools]

/** An MCP server's tool as a record the registry can offer once it has been found. */
export function mcpTool(t: mcp.McpTool): Tool {
  const name = `mcp__${t.server}__${t.name}`
  return {
    schema: { type: 'function', function: { name, description: t.description || `${t.name} on ${t.server}`, parameters: t.inputSchema } },
    writes: !t.readOnly,
    subject: (a) => summariseArgs(a),
    execute: (ctx, args) => {
      const id = splitToolName(name)
      if (!id) throw new Error(`Not an MCP tool: ${name}`)
      return ctx.callMcp(id.server, id.tool, args)
    }
  }
}

/**
 * The environment's capabilities for one turn: the shell behind approval,
 * and the project's hooks after a write.
 */
export const ORACLE_SYSTEM = `You are a second opinion, asked by another model in the middle of its work. You see only what it sent: a question and, often, the material it is about. Answer the question directly and plainly. Say what is wrong or risky before what is fine. Where the material is incomplete, say what you would need to see rather than guessing. Be concrete: name the line, the case, the assumption. No preamble.`

export function coreOps(turn: Turn): Pick<ToolContext, 'runCommand' | 'afterWrite' | 'findTools' | 'callMcp' | 'askOracle' | 'commandOutput' | 'stopCommand'> {
  const { id: requestId, conversationId, project, root, role, model, emitTerminal } = turn
  // The judge's denials this turn; past a few the person is asked directly.
  let deniedInARow = 0
  let deniedInAll = 0
  /** A card for something that is not a shell command, answered the same way. */
  const askCard = async (label: string, note?: string): Promise<'once' | 'always' | 'deny' | 'timeout' | 'cancelled'> => {
    const approvalId = randomUUID()
    emitTerminal({ type: 'approval', conversationId, approvalId, command: label, cwd: root ?? '', note })
    log.warn('command', 'waiting for approval', { command: label.slice(0, 120) })
    const decision = await commands.askApproval(approvalId, or.signalFor(requestId))
    emitTerminal({ type: 'approval_resolved', conversationId, approvalId, decision })
    return decision
  }
  /** Where each background command was last read from, this turn, so a read returns only what is new. */
  const readFrom = new Map<string, number>()
  const jobOf = (handle: string): commands.Job => {
    const j = commands.job(handle)
    if (!j || j.conversationId !== conversationId) throw new Error(`No background command here is called ${handle}. run_command with background: true returns a handle.`)
    return j
  }
  return {
    commandOutput: async (handle, waitFor, timeoutSec) => {
      jobOf(handle)
      let pattern: RegExp | null = null
      if (waitFor) {
        try {
          pattern = new RegExp(waitFor)
        } catch (e) {
          throw new Error(`wait_for is not a valid pattern: ${(e as Error).message}`)
        }
      }
      const since = readFrom.get(handle) ?? 0
      const r = await commands.waitFor(handle, { since, pattern, timeoutMs: Math.min(Math.max(timeoutSec, 1), 600) * 1000 })
      if (!r) throw new Error(`${handle} is gone.`)
      readFrom.set(handle, r.offset)
      const state = r.done ? `It has ended${r.exitCode === null ? '' : ` with exit code ${r.exitCode}`}.` : pattern ? (r.matched ? 'The pattern appeared; it is still running.' : `The pattern did not appear within ${timeoutSec}s; it is still running.`) : 'It is still running.'
      const body = r.text.trim() ? r.text.slice(-60_000) : '(nothing new)'
      return `${state}\n\n${body}`
    },
    stopCommand: async (handle) => {
      const j = jobOf(handle)
      if (j.done) return `${handle} had already ended${j.exitCode === null ? '' : ` with exit code ${j.exitCode}`}.`
      commands.stop(handle)
      log.info('command', 'background command stopped by the model', { handle: handle.slice(0, 8), command: j.command.slice(0, 80) })
      return `${handle} was asked to stop, and will be made to in a few seconds if it does not.`
    },
    /*
      The oracle is the project's `oracle` tier, or the conversation's own
      model when none is named. It sees the question and the material and
      nothing else, so the answer is about what was sent; its cost lands on
      the tool row like any other spend.
    */
    askOracle: async (question, material) => {
      const oracle = tierModel(parseTiers(project?.tiers ?? ''), ORACLE_TIER, model)
      const at = Date.now()
      const r = await or.chatOnce(
        oracle,
        [
          { role: 'system', content: ORACLE_SYSTEM },
          { role: 'user', content: material.trim() ? `${question.trim()}\n\n---\n\n${material.trim().slice(0, 120_000)}` : question.trim() }
        ],
        { maxTokens: 2500, temperature: 0.2, signal: or.signalFor(requestId) }
      )
      turn.spend(r.cost)
      log.info('oracle', 'answered', { model: oracle, ms: log.since(at), cost: r.cost, chars: r.content.length })
      return `Oracle (${oracle}):\n\n${r.content.trim() || '(it said nothing)'}`
    },
    findTools: async (query) => {
      const all = mcp.listing()
      const found = rankTools(query, all)
      turn.loadTools(found.map((t) => t.name))
      return formatListing(found, all.length)
    },
    /*
      An MCP tool runs in a process of its own and can do whatever its
      server can; no sandbox covers it. So it is asked for like a shell
      command unless the tool says it only reads or the person has marked
      the server trusted. "Always" allowlists the server and tool.
    */
    callMcp: async (server, tool, args) => {
      const t = mcp.toolByName(`mcp__${server}__${tool}`)
      if (!t) throw new Error(`No connected MCP server offers ${server}.${tool}. Call find_tools to see what is available.`)
      const label = `mcp: ${server}.${tool} ${JSON.stringify(args).slice(0, 400)}`
      if (!t.readOnly && !mcp.trusted(server) && !(project && commands.isAllowlisted(project.id, label))) {
        const decision = await askCard(label, `An MCP tool on the server "${server}". It runs outside the sandbox, with whatever that server can do.`)
        if (decision === 'cancelled') return 'The turn was stopped before anyone decided, so the tool did not run.'
        if (decision === 'timeout') return 'Nobody answered the request to run that within ten minutes. Say what you were trying to do and let them decide.'
        if (decision === 'deny') return 'Refused: the person declined to run that. Try a different approach, or ask them why.'
        if (decision === 'always' && project) db.allowCommand(project.id, `mcp: ${server}.${tool}`)
      }
      return mcp.call(server, tool, args, or.signalFor(requestId))
    },
    afterWrite: (path) =>
      root && project
        ? runHooks({ root, hooks: project.hooks, path, conversationId, emitTerminal })
        : Promise.resolve(''),
    /*
      The path jail does not cover shell commands — a command can name any
      absolute path — so approval is the boundary here. The hard deny list is
      checked first and cannot be waived; anything else either matches the
      project's allowlist or waits for a decision.
    */
    runCommand: async (command, timeoutSec, unsandboxed = false, background = false) => {
      if (!root) throw new Error('This project has no folder, so there is nowhere to run.')

      const denied = commands.hardDenyReason(command)
      if (denied) {
        return `Refused: that command ${denied}, and Harbor never runs it. Ask the person to run it themselves if it is really needed.`
      }

      /*
        Inside the sandbox a command can change the project and reach the
        allowed domains and nothing else, so it may run on the project's
        say-so. Outside it, the person decides every time, whatever the
        allowlist or auto-approve say: that is the point of asking.
      */
      const boxed = sandbox.isReady() && !unsandboxed
      // A run is meant to be left alone: its director and workers do not ask, inside a repository.
      const unattended = role === 'director' || role === 'worker'
      const auto = project?.autoApprove || unattended
        ? { autoApprove: true, isRepo: await workspace.isRepo(root).catch(() => false) }
        : { autoApprove: false, isRepo: false }
      if (unsandboxed) {
        log.warn('command', 'asked to run outside the sandbox', { command: command.slice(0, 120) })
      } else if (autoApproves(auto)) {
        log.info('command', `ran without asking: auto-approve is on and the folder is under version control${boxed ? '' : '; no sandbox: ' + sandbox.unavailable()}`, { command: command.slice(0, 120) })
      }
      let mustAsk = unsandboxed || (!autoApproves(auto) && (!project || !commands.isAllowlisted(project.id, command)))
      let note = ''
      /*
        The judge, when the person has chosen it: a command that only reads
        runs; the rest, sandboxed, is put to a cheap model with what the
        person said and nothing the agent read. A denial becomes the card,
        with the reason on it. Outside the sandbox nobody but the person
        decides.
      */
      if (mustAsk && !unsandboxed && boxed && judge.mode() === 'judge' && deniedInARow < CONSECUTIVE_DENIALS && deniedInAll < TOTAL_DENIALS) {
        if (isSafeCommand(command)) {
          mustAsk = false
          log.info('command', 'ran unasked: it only reads', { command: command.slice(0, 120) })
        } else {
          const verdict = await judge.judge({ conversationId, command, cwd: root, instructions: project?.systemPrompt ?? '', fallbackModel: model, signal: or.signalFor(requestId) })
          if (verdict.allow) {
            mustAsk = false
            deniedInARow = 0
          } else {
            deniedInARow++
            deniedInAll++
            note = `The judge would not allow this on its own: ${verdict.reason}.${deniedInARow >= CONSECUTIVE_DENIALS ? ' You are asked directly for the rest of this turn.' : ''}`
          }
        }
      }
      if (mustAsk) {
        const held = autoApproveHeld(auto)
        if (held && !unsandboxed) log.warn('command', held)
        const approvalId = randomUUID()
        emitTerminal({ type: 'approval', conversationId, approvalId, command, cwd: root, unsandboxed, note: note || undefined })
        log.warn('command', 'waiting for approval', { command: command.slice(0, 120) })
        const askedAt = Date.now()
        const decision = await commands.askApproval(approvalId, or.signalFor(requestId))
        log.info('command', `approval ${decision}`, { ms: log.since(askedAt) })
        emitTerminal({ type: 'approval_resolved', conversationId, approvalId, decision })

        if (decision === 'cancelled') {
          return 'The turn was stopped before anyone decided, so the command did not run.'
        }
        if (decision === 'timeout') {
          return 'Nobody answered the request to run that within ten minutes. Say what you were trying to do and let them decide.'
        }
        if (decision === 'deny') {
          return 'Refused: the person declined to run that. Try a different approach, or ask them why.'
        }
        if (decision === 'always' && project) {
          db.allowCommand(project.id, command.trim())
        }
      }

      const handle = randomUUID()
      emitTerminal({ type: 'start', conversationId, handle, command, source: 'agent' })

      if (background) {
        const j = await commands.start(
          handle,
          conversationId,
          command,
          root,
          (text, stream) => emitTerminal({ type: 'chunk', conversationId, handle, text, stream }),
          (exitCode) => emitTerminal({ type: 'end', conversationId, handle, exitCode, timedOut: false }),
          boxed ? { root, id: handle, signal: undefined } : undefined
        )
        log.info('command', 'started in the background', { handle: handle.slice(0, 8), command: command.slice(0, 80), sandboxed: j.sandboxed })
        // A moment, so a command that dies at once says so in the same breath.
        const first = await commands.waitFor(handle, { since: 0, pattern: null, timeoutMs: 1_500 })
        readFrom.set(handle, first?.offset ?? 0)
        const head = first?.text.trim() ? `\n\nSo far:\n${first.text.slice(-4_000)}` : ''
        return first?.done
          ? `Started in the background as ${handle}, and it ended already with exit code ${first.exitCode ?? 'unknown'}.${head}`
          : `Started in the background as ${handle}. It keeps running after this turn. Read what it prints with command_output (wait_for a line such as "listening|ready|error"), and end it with stop_command.${head}`
      }

      const result = await commands.run(
        handle,
        command,
        root,
        (text, stream) => emitTerminal({ type: 'chunk', conversationId, handle, text, stream }),
        Math.min(Math.max((timeoutSec ?? 120) * 1000, 1000), 600_000),
        boxed ? { root, id: handle, signal: or.signalFor(requestId) } : undefined
      )

      emitTerminal({
        type: 'end',
        conversationId,
        handle,
        exitCode: result.exitCode,
        timedOut: result.timedOut
      })

      const head = result.timedOut
        ? `Timed out after ${timeoutSec ?? 120}s and was killed.`
        : `Exit code ${result.exitCode ?? 'unknown'}.`
      const tail = `${result.truncated ? '\n[output truncated]' : ''}${
        result.sandboxed && result.exitCode !== 0 && !result.timedOut
          ? '\n[Ran inside the sandbox: writes only in the project and scratch folders, network only to allowed domains. If it failed for want of one of those, run it again with unsandboxed: true and say why; the person will be asked.]'
          : ''
      }`
      return `${head}\n${result.output.trim() || '(no output)'}${tail}`
    },
  }
}
