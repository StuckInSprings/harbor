import type { Message } from '../../shared/types'

/**
 * Main-process copy of the branch walk. The renderer has its own in
 * src/lib/tree.ts for rendering; this one exists so prompt assembly does not
 * depend on anything the renderer sends.
 */
export function pathToLeaf(messages: Message[], leafId: string | null): Message[] {
  if (!leafId) return []
  const byId = new Map(messages.map((m) => [m.id, m]))
  const path: Message[] = []
  const seen = new Set<string>()
  let node = byId.get(leafId)
  while (node && !seen.has(node.id)) {
    seen.add(node.id)
    path.push(node)
    node = node.parentId ? byId.get(node.parentId) : undefined
  }
  return path.reverse()
}
