import type { Message } from '../../shared/types'

/**
 * A conversation is a tree. Editing a message or retrying a reply creates a
 * sibling rather than overwriting, and the conversation remembers which leaf
 * is on screen. The path from root to that leaf is what gets rendered and what
 * gets sent to the model — other branches stay on disk, out of the way.
 */

const byTime = (a: Message, b: Message): number => a.createdAt - b.createdAt

export function childrenOf(messages: Message[], parentId: string | null): Message[] {
  return messages.filter((m) => m.parentId === parentId).sort(byTime)
}

export function siblingsOf(messages: Message[], m: Message): Message[] {
  return childrenOf(messages, m.parentId)
}

/** Walk down the newest child at each step until the branch ends. */
export function deepestLeaf(messages: Message[], from: Message): Message {
  let node = from
  for (;;) {
    const kids = childrenOf(messages, node.id)
    if (kids.length === 0) return node
    node = kids[kids.length - 1]
  }
}

/** Root-to-leaf path. Falls back to the newest branch when no leaf is set. */
export function pathTo(messages: Message[], leafId: string | null): Message[] {
  if (messages.length === 0) return []

  const byId = new Map(messages.map((m) => [m.id, m]))
  let leaf = leafId ? byId.get(leafId) : undefined

  if (!leaf) {
    const roots = childrenOf(messages, null)
    if (roots.length === 0) return []
    leaf = deepestLeaf(messages, roots[roots.length - 1])
  }

  const path: Message[] = []
  let node: Message | undefined = leaf
  const seen = new Set<string>()
  while (node && !seen.has(node.id)) {
    seen.add(node.id)
    path.push(node)
    node = node.parentId ? byId.get(node.parentId) : undefined
  }
  return path.reverse()
}

/** The sibling one step either side, for the ◀ n/m ▶ switcher. */
export function siblingStep(
  messages: Message[],
  m: Message,
  direction: -1 | 1
): { target: Message; index: number; count: number } | null {
  const sibs = siblingsOf(messages, m)
  if (sibs.length < 2) return null
  const here = sibs.findIndex((s) => s.id === m.id)
  const next = here + direction
  if (next < 0 || next >= sibs.length) return null
  return { target: sibs[next], index: next, count: sibs.length }
}

export function siblingPosition(messages: Message[], m: Message): { index: number; count: number } {
  const sibs = siblingsOf(messages, m)
  return { index: sibs.findIndex((s) => s.id === m.id) + 1, count: sibs.length }
}

/**
 * Every message's place among its siblings, in one pass. The transcript
 * asked per row, which was a scan of the whole list per row per render, and
 * during a reply a render is every frame.
 */
export function siblingPositions(messages: Message[]): Map<string, { index: number; count: number }> {
  const groups = new Map<string | null, Message[]>()
  for (const m of messages) {
    const g = groups.get(m.parentId)
    if (g) g.push(m)
    else groups.set(m.parentId, [m])
  }
  const out = new Map<string, { index: number; count: number }>()
  for (const g of groups.values()) {
    g.sort(byTime)
    g.forEach((m, i) => out.set(m.id, { index: i + 1, count: g.length }))
  }
  return out
}
