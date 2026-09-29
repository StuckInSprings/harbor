import { Notification, BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import type { ApprovalDecision, RunOptions, StreamEvent, TerminalEvent } from '../../../shared/types'
import * as db from '../db'
import * as or from '../openrouter'
import * as compaction from '../compact'
import * as commands from '../commands'
import * as log from '../log'
import { approvalNotice, shouldNotify } from '../../../shared/approval'
import { runTurn, conversationOf, emptyUsage } from '../run'
import { pendingQuestion, answerQuestion } from '../tools/director'
import * as goal from '../goal'
import { asideMessages } from '../../../shared/fanout'
import { handle, broadcast, rootFor, type Ipc } from './shared'

/**
 * A turn: started here, reported through events to every window, announced
 * to the desktop when it ends and nobody is looking. The shell's approval
 * decisions and the commands the person types come through here too.
 */
let launcher: ((requestId: string, opts: RunOptions, notify: boolean) => void) | null = null

/** Starts a turn from main, reported to every window like one the window started; notify tells the person when it ends. */
export function launch(requestId: string, opts: RunOptions, notify = false): void {
  if (!launcher) throw new Error('Turns are not ready yet.')
  launcher(requestId, opts, notify)
}

export function register(ipc: Ipc): void {
  const win = ipc.win
  /* turns */
  const emit = (e: StreamEvent): void => {
    // Every event says which conversation it belongs to, so a conversation opened mid-turn can pick its turn up.
    // The owner rides as its own field: a worker event already names the worker in conversationId, and that must stand.
    broadcast('chat:event', { ...e, owner: conversationOf(e.requestId) })
    if (e.type === 'done' || e.type === 'error') {
      // A conversation with a goal judges the turn and may go on; the desktop is told only when it really ends.
      const conv = conversationOf(e.requestId)
      if (conv && goal.active(conv)) {
        void goal.afterTurn(conv, e.requestId, e.type === 'error', emit, emitTerminal).then((continued) => {
          if (!continued) notifyRunEnd(e.requestId, e.type === 'error' ? e.message : null)
        })
      } else notifyRunEnd(e.requestId, e.type === 'error' ? e.message : null)
    }
    if (e.type === 'worker' && e.state === 'waiting') notifyQuestion(e.conversationId, e.question ?? '')
  }

  /*
    A run is meant to be left alone, so its end is the one moment the person
    needs telling about. The turn's conversation is looked up from the
    request; only a director's end is announced, and only when the window is
    not in front.
  */
  const notifyRunEnd = (requestId: string, error: string | null): void => {
    const conv = runningTurns.get(requestId)
    runningTurns.delete(requestId)
    if (!conv || win.isDestroyed() || !Notification.isSupported()) return
    const focused = BrowserWindow.getAllWindows().some((w) => !w.isDestroyed() && w.isFocused())
    if (conv.role === 'director') {
      if (!shouldNotify({ focused, setting: db.getSetting('notify_approvals') })) return
    } else if (!shouldNotify({ focused, setting: db.getSetting('notify_replies') })) return
    // A reply's first line is the notification; a director's end is an event in itself.
    const said = conv.role === 'director' ? '' : ([...db.listMessages(conv.id)].reverse().find((m) => m.role === 'assistant' && m.content.trim())?.content.trim() ?? '')
    const n = new Notification({
      title: error ? (conv.role === 'director' ? 'The director stopped' : `${conv.title} stopped`) : conv.role === 'director' ? 'The director is waiting on you' : conv.title,
      body: error
        ? `${conv.role === 'director' ? `${conv.title}: ` : ''}${error.slice(0, 120)}`
        : conv.role === 'director'
          ? `${conv.title} has finished its turn. Read the board, or reply.`
          : said.split('\n').find((l) => l.trim()) ?.slice(0, 160) ?? 'Replied.'
    })
    n.on('click', () => {
      if (win.isDestroyed()) return
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
      win.webContents.send('ui:openConversation', conv.id)
    })
    n.show()
  }
  const runningTurns = new Map<string, { id: string; title: string; role: string }>()

  /* A worker's question is the run stopped until the person answers; the desktop says so when the window is not in front. */
  const notifyQuestion = (conversationId: string, question: string): void => {
    if (win.isDestroyed() || !Notification.isSupported()) return
    if (!shouldNotify({ focused: win.isFocused(), setting: db.getSetting('notify_approvals') })) return
    const conv = db.getConversation(conversationId)
    const n = new Notification({ title: `${conv?.title ?? 'A worker'} has a question`, body: question.slice(0, 160), silent: false })
    n.on('click', () => {
      if (win.isDestroyed()) return
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
      win.webContents.send('ui:openConversation', conversationId)
    })
    n.show()
  }
  const emitTerminal = (e: TerminalEvent): void => {
    broadcast('terminal:event', e)
    if (e.type === 'approval') notifyApproval(e.conversationId, e.command)
  }

  /*
    A request nobody is looking at is a run stalled for ten minutes. When the
    window is not in front, the desktop gets a notification; clicking it
    brings the window up on that conversation.
  */
  const notifyApproval = (conversationId: string, command: string): void => {
    if (win.isDestroyed()) return
    if (!Notification.isSupported()) return
    if (!shouldNotify({ focused: win.isFocused(), setting: db.getSetting('notify_approvals') })) return
    const conv = db.getConversation(conversationId)
    const { title, body } = approvalNotice({ conversationTitle: conv?.title ?? '', command })
    log.info('approval', 'told the desktop', { conversation: conv?.title ?? conversationId, command: command.slice(0, 80) })
    const n = new Notification({ title, body, silent: false })
    n.on('click', () => {
      if (win.isDestroyed()) return
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
      win.webContents.send('ui:openConversation', conversationId)
    })
    n.show()
  }

  /*
    The bridge starts turns too; they report to the windows the same way.
    The person is told when one ends only when it is waiting on them (an
    interview's questions); otherwise Claude is the one waiting.
  */
  launcher = (requestId, opts, notify) => {
    const conv = notify ? db.getConversation(opts.conversationId) : null
    if (conv) runningTurns.set(requestId, { id: conv.id, title: conv.title, role: conv.role })
    void runTurn({ ...opts, requestId }, emit, emitTerminal)
  }

  handle('chat:run', async (requestId: string, opts: RunOptions) => {
    const conv = db.getConversation(opts.conversationId)
    // A worker waiting on a question: the message just sent is the answer, and its own turn is still open.
    if (conv?.role === 'worker' && opts.parentId && pendingQuestion(conv.id)) {
      const sent = db.listMessages(conv.id).find((m) => m.id === opts.parentId)
      if (sent?.role === 'user' && answerQuestion(conv.id, sent.content)) {
        emit({ type: 'done', requestId, ...emptyUsage() })
        return true
      }
    }
    // Every turn started by the person is announced when it ends and nobody is looking.
    if (conv) runningTurns.set(requestId, { id: conv.id, title: conv.title, role: conv.role })
    // A goal continues with the same options the person last sent with.
    goal.remember(opts)
    // Deliberately not awaited: the turn reports itself through events.
    void runTurn({ ...opts, requestId }, emit, emitTerminal)
    return true
  })

  /* commands — approval is the boundary for shell access */
  handle('commands:decide', (approvalId: string, decision: ApprovalDecision) =>
    commands.decide(approvalId, decision)
  )
  handle('commands:allowed', (projectId: string) => db.listAllowedCommandRows(projectId))
  handle('commands:forget', (rowId: string) => {
    db.removeAllowedCommand(rowId)
    return true
  })
  handle('commands:kill', (handle_: string) => {
    commands.killRunning(handle_)
    return true
  })

  /*
    A command you type yourself needs no approval — you are the approval. The
    hard deny list still applies, since it is about what Harbor will never do.
  */
  handle('commands:runFromTerminal', async (conversationId: string, command: string) => {
    const root = rootFor(conversationId)
    const handle_ = randomUUID()

    // A refusal belongs in the scrollback, where the command would have gone,
    // rather than vanishing into a rejected promise.
    const denied = commands.hardDenyReason(command)
    if (denied) {
      emitTerminal({ type: 'start', conversationId, handle: handle_, command, source: 'you' })
      emitTerminal({
        type: 'chunk',
        conversationId,
        handle: handle_,
        text: `Harbor never runs this: it ${denied}. Run it yourself in a terminal if you need it.\n`,
        stream: 'stderr'
      })
      emitTerminal({
        type: 'end',
        conversationId,
        handle: handle_,
        exitCode: null,
        timedOut: false
      })
      return true
    }

    emitTerminal({ type: 'start', conversationId, handle: handle_, command, source: 'you' })
    const result = await commands.run(handle_, command, root, (text, stream) =>
      emitTerminal({ type: 'chunk', conversationId, handle: handle_, text, stream })
    )
    emitTerminal({
      type: 'end',
      conversationId,
      handle: handle_,
      exitCode: result.exitCode,
      timedOut: result.timedOut
    })
    return true
  })
  /* A goal: set with the dollars it may spend, or cleared. */
  handle('goal:set', (conversationId: string, text: string, budget: number) => {
    db.setGoal(conversationId, text.trim() || null, Number(budget) || 0)
    log.info('goal', text.trim() ? 'set' : 'cleared', { conversation: conversationId.slice(0, 8), budget })
    return db.getConversation(conversationId)
  })
  handle('goal:clear', (conversationId: string) => {
    db.setGoal(conversationId, null, 0)
    return true
  })
  /*
    A question about one reply, answered beside it and kept nowhere: the
    reply's own model is asked with the reply and the question alone, so
    the conversation's context is not one token longer for it.
  */
  handle('chat:aside', async (conversationId: string, messageId: string, question: string) => {
    const m = db.listMessages(conversationId).find((x) => x.id === messageId)
    if (!m) throw new Error('That reply is gone.')
    if (!question.trim()) throw new Error('Ask something.')
    const model = m.model ?? db.getConversation(conversationId)?.model
    if (!model) throw new Error('No model to ask.')
    const at = Date.now()
    const r = await or.chatOnce(model, asideMessages(m.content, question), { maxTokens: 1500, timeoutMs: 120_000 })
    log.info('aside', 'answered', { model, ms: Date.now() - at, cost: r.cost, chars: r.content.length })
    return { content: r.content, cost: r.cost, model }
  })
  handle('chat:cancel', (requestId: string) => {
    or.cancel(requestId)
    return true
  })

  /* Compaction by hand — the same operation the turn loop runs when it must. */
  handle('chat:compact', async (conversationId: string, model: string, contextLength: number) => {
    const conv = db.getConversation(conversationId)
    if (!conv?.leafId) throw new Error('Nothing to compact yet.')
    const summariser = db.getSetting('extraction_model') || model
    /*
      Asked for by hand, so it should visibly do something: everything before
      the latest exchange is summarised, whatever the window has room for.
      The automatic version in run.ts keeps as much as fits instead.
    */
    void contextLength
    const done = await compaction.compact(
      conversationId,
      conv.leafId,
      0,
      compaction.withModel(summariser)
    )
    if (!done) {
      throw new Error(
        'Too little here to compact. It needs more than a couple of exchanges before the latest question.'
      )
    }
    return done
  })

}
