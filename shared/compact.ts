/**
 * Compaction: making room in a conversation that has outgrown its model.
 *
 * The older part of the branch is summarised and a new branch is started
 * whose root is that summary, followed by copies of the most recent messages.
 * Nothing is deleted. The original branch stays where it was, a sibling of
 * the new root, reachable with the same switcher used for any other fork.
 *
 * This file is the arithmetic — where to cut, what to say to the summariser,
 * when it is time. The database and network work is in electron/main.
 */

import type { Message } from './types'

/** Chars per token is a guess everywhere in Harbor; it only has to be consistent. */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4)

/*
  An image is sent as base64 and billed as a picture: a 300 KB screenshot is
  400 KB of characters and roughly 1,500 tokens, not 100,000. Counting the
  characters made every turn with an image on a 128K model compact, once
  per turn, for nothing. A PDF is parsed to text server side; its size in
  tokens is unknowable here, so a few pages' worth is assumed.
*/
export const IMAGE_TOKENS = 1500
export const PDF_TOKENS = 3000

/*
  Before the older part of a conversation is summarised, two cheaper things
  are tried, in the order the field settled on: old tool results are
  replaced by a stub (the model read them when they arrived and rarely
  again), and old images are dropped (a picture is worth its tokens once).
  Both are marked on the row and never unmarked, so what the model is sent
  changes once and the cached prefix rebuilds once.
*/
/** Share of the window at which trimming starts; compaction waits for the reply reserve. */
export const TRIM_AT = 0.5
/** The newest tool results are kept whole: the model is still working from them. */
export const KEEP_RESULTS = 6
/** Images in the newest user messages are kept; older ones go. */
export const KEEP_IMAGES = 3
/** A result shorter than this is not worth a stub. */
export const MIN_RESULT_CHARS = 400

export function resultStub(content: string): string {
  const first = content.split('\n').find((l) => l.trim()) ?? ''
  return `[Cleared from the context to make room: a ${content.length.toLocaleString()}-character result that began "${first.trim().slice(0, 80)}". Run the tool again if it is needed.]`
}

/** Which rows on the path to clear: old tool results, and old images. Rows already trimmed are not counted. */
export function chooseTrim(path: Message[], opts: { keepResults?: number; keepImages?: number; minResultChars?: number } = {}): { results: Message[]; images: Message[] } {
  const keepResults = opts.keepResults ?? KEEP_RESULTS
  const keepImages = opts.keepImages ?? KEEP_IMAGES
  const minChars = opts.minResultChars ?? MIN_RESULT_CHARS
  const toolRows = path.filter((m) => m.role === 'tool')
  const results = toolRows.slice(0, Math.max(0, toolRows.length - keepResults)).filter((m) => !m.trimmed && m.content.length > minChars)
  const withImages = path.filter((m) => m.role === 'user' && hasHeavyAttachment(m))
  const images = withImages.slice(0, Math.max(0, withImages.length - keepImages)).filter((m) => !m.trimmed)
  return { results, images }
}

function hasHeavyAttachment(m: Message): boolean {
  if (!m.attachments) return false
  try {
    return (JSON.parse(m.attachments) as { kind?: string }[]).some((a) => a.kind === 'image' || a.kind === 'pdf')
  } catch {
    return false
  }
}

/** What one stored message will cost on the wire: its text, its tool calls, and its attachments by kind. */
export function messageTokens(m: Message): number {
  if (m.trimmed && m.role === 'tool') return estimateTokens(resultStub(m.content)) + 4
  let n = estimateTokens(m.content) + 4
  if (m.toolCalls) n += estimateTokens(m.toolCalls)
  if (m.attachments && m.trimmed) return n + 20
  if (m.attachments) {
    try {
      const list = JSON.parse(m.attachments) as { kind?: string; size?: number }[]
      for (const a of list) {
        if (a.kind === 'image') n += IMAGE_TOKENS
        else if (a.kind === 'pdf') n += PDF_TOKENS
        else n += Math.ceil((a.size ?? 0) / 4)
      }
    } catch {
      /* unreadable attachment list: counted as nothing rather than as its JSON */
    }
  }
  return n
}

/** The same estimate over messages already in wire form, where an image is a data URL. */
export function estimateWireTokens(messages: unknown[]): number {
  let n = 0
  for (const raw of messages) {
    const m = raw as { content?: unknown; tool_calls?: unknown }
    n += 4
    if (typeof m.content === 'string') n += estimateTokens(m.content)
    else if (Array.isArray(m.content)) {
      for (const part of m.content as { type?: string; text?: string }[]) {
        if (part.type === 'image_url') n += IMAGE_TOKENS
        else if (part.type === 'file') n += PDF_TOKENS
        else if (typeof part.text === 'string') n += estimateTokens(part.text)
        else n += estimateTokens(JSON.stringify(part))
      }
    }
    if (m.tool_calls) n += estimateTokens(JSON.stringify(m.tool_calls))
  }
  return n
}

/** Compaction begins once the prompt would fill this much of the window. */
export const COMPACT_AT = 0.8

/**
 * Whether a prompt of this size needs compacting before it is sent. The
 * reserve is the room the reply needs; a prompt that fits with nowhere for
 * the answer to go has not fitted.
 */
export function shouldCompact(promptTokens: number, contextLength: number, reserve: number): boolean {
  if (contextLength <= 0) return false
  return promptTokens + reserve > contextLength * COMPACT_AT
}

export interface Cut {
  /** Oldest first: what the summary replaces. */
  summarise: Message[]
  /** Oldest first: carried over as copies, starting at a user message. */
  keep: Message[]
}

/**
 * Where to cut. Walks back from the leaf until the kept tail would exceed the
 * budget, then extends to the nearest user message so the tail never opens on
 * a reply to something it cannot see, or a tool result without its call.
 * Returns null when there is too little before the cut to be worth a summary.
 */
export function chooseCut(path: Message[], keepTokens: number): Cut | null {
  if (path.length < 4) return null

  let spent = 0
  let start = path.length
  for (let i = path.length - 1; i >= 0; i--) {
    const cost = messageTokens(path[i])
    if (spent + cost > keepTokens && start < path.length) break
    spent += cost
    start = i
  }
  // The tail opens on a user message, or there is no clean seam.
  while (start < path.length && path[start].role !== 'user') start++
  // Never keep nothing: the latest user message always survives.
  if (start >= path.length) {
    for (let i = path.length - 1; i >= 0; i--) {
      if (path[i].role === 'user') {
        start = i
        break
      }
    }
  }
  if (start < 2) return null
  return { summarise: path.slice(0, start), keep: path.slice(start) }
}

/** Per-message ceiling in the transcript sent to the summariser. Tool output is the usual offender. */
export const TRANSCRIPT_CAP = 1500

/** The conversation as the summariser sees it: plain, capped, no attachments. */
export function transcriptOf(messages: Message[]): string {
  const lines: string[] = []
  for (const m of messages) {
    if (m.error) continue
    const body = m.content.trim()
    if (m.role === 'tool') {
      if (body) lines.push(`TOOL RESULT: ${clip(body)}`)
      continue
    }
    if (m.role === 'assistant' && m.toolCalls) {
      let calls: { function?: { name?: string; arguments?: string } }[] = []
      try {
        calls = JSON.parse(m.toolCalls) as typeof calls
      } catch {
        calls = []
      }
      const named = calls
        .map((c) => `${c.function?.name ?? 'tool'}(${clip(c.function?.arguments ?? '', 200)})`)
        .join(', ')
      lines.push(`ASSISTANT${body ? `: ${clip(body)}` : ''}${named ? ` [called ${named}]` : ''}`)
      continue
    }
    if (!body) continue
    lines.push(`${m.role.toUpperCase()}: ${clip(body)}`)
  }
  return lines.join('\n\n')
}

function clip(text: string, max = TRANSCRIPT_CAP): string {
  return text.length > max ? `${text.slice(0, max)}… [${text.length - max} more]` : text
}

export const SUMMARY_RUBRIC = `You are summarising the earlier part of a conversation so it can continue with the rest of the context freed. Write for the assistant that will pick the conversation up, not for the person. Include, under short headings: what the person is trying to do and any constraints they gave; what has been done so far, naming files, commands and paths exactly; decisions made and why; anything still open or promised. Keep every identifier, path and number verbatim. Leave out pleasantries and anything already superseded. Plain prose and short lists; no preamble.`

/** The text at the top of the summary message, so a reader knows what it is. */
export const summaryHeader = (count: number): string =>
  `Summary of the ${count} earlier messages in this conversation, written when it was compacted. The original messages are still there on the other branch.`

export function summaryMessage(count: number, summary: string): string {
  return `${summaryHeader(count)}\n\n${summary.trim()}`
}
