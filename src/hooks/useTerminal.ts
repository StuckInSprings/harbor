import { useEffect, useRef, useState } from 'react'
import type { PendingApproval, TermBlock } from '../components/Terminal'
import type { LiveTurn } from './useTurns'
import { toolLabel, type Phase } from '../../shared/activity'
import { api } from '../lib/api'

/**
 * The terminal pane's scrollback per conversation, and the approval cards:
 * both fed by the command events main sends for every window.
 */
/** How much of a block's output is kept on screen; the file and the model have the whole of it. */
const OUTPUT_KEEP = 200_000

export function useTerminal(opts: {
  turnsIn: (conversationId: string) => LiveTurn[]
  enter: (requestId: string, phase: Phase, detail?: string) => void
  /** The pane opens itself on the first command, if nothing else is showing. */
  openPane: () => void
}): {
  terminal: Record<string, TermBlock[]>
  approvals: PendingApproval[]
} {
  const [terminal, setTerminal] = useState<Record<string, TermBlock[]>>({})
  const chunks = useRef(new Map<string, string>())
  const chunkFrame = useRef(0)
  const [approvals, setApprovals] = useState<PendingApproval[]>([])
  // Subscribed once; the latest helpers are read through this.
  const ref = useRef(opts)
  ref.current = opts

  useEffect(() => {
    return api.commands.onEvent((e) => {
      const conv = e.conversationId
      switch (e.type) {
        case 'approval':
          /*
            Asked in the conversation, not in a pane. A pane can be covered by
            whatever else is open, and a blocked run whose question nobody can
            see is indistinguishable from the app having hung.
          */
          setApprovals((list) => [...list, { approvalId: e.approvalId, conversationId: conv, command: e.command, cwd: e.cwd, unsandboxed: e.unsandboxed, note: e.note }])
          // The turn is blocked on a person now, and should say so rather than
          // going on claiming to be running a command. The event names the
          // conversation, so every turn there that is mid-tool is told; with
          // one turn, which is the usual case, that is exact.
          for (const t of ref.current.turnsIn(conv)) {
            if (t.activity?.phase === 'tool') ref.current.enter(t.requestId, 'approval', e.command)
          }
          return
        case 'approval_resolved':
          setApprovals((list) => list.filter((a) => a.approvalId !== e.approvalId))
          for (const t of ref.current.turnsIn(conv)) {
            if (t.activity?.phase === 'approval') ref.current.enter(t.requestId, 'tool', toolLabel(t.tools))
          }
          return
        case 'start':
          setTerminal((t) => ({ ...t, [conv]: [...(t[conv] ?? []), { handle: e.handle, command: e.command, source: e.source, output: '', done: false }] }))
          ref.current.openPane()
          return
        case 'chunk': {
          // Output arrives in many small pieces; they are gathered and handed to React once per frame, and a block keeps its last part.
          const key = `${conv}\u0000${e.handle}`
          chunks.current.set(key, (chunks.current.get(key) ?? '') + e.text)
          if (!chunkFrame.current) {
            chunkFrame.current = requestAnimationFrame(() => {
              chunkFrame.current = 0
              const batch = chunks.current
              chunks.current = new Map()
              setTerminal((t) => {
                const next = { ...t }
                for (const [k, text] of batch) {
                  const [c, handle] = k.split('\u0000')
                  next[c] = (next[c] ?? []).map((b) => (b.handle === handle ? { ...b, output: (b.output + text).slice(-OUTPUT_KEEP) } : b))
                }
                return next
              })
            })
          }
          return
        }
        case 'end':
          setTerminal((t) => ({ ...t, [conv]: (t[conv] ?? []).map((b) => (b.handle === e.handle ? { ...b, done: true, exitCode: e.exitCode, timedOut: e.timedOut } : b)) }))
      }
    })
  }, [])

  return { terminal, approvals }
}
