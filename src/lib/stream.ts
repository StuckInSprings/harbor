/**
 * Where a streaming reply can be cut for rendering. Markdown is parsed
 * whole, so parsing the accumulated text every frame costs more with every
 * token. Cut at the last paragraph break that is not inside an open code
 * fence, the part before it is parsed once and kept, and only the tail
 * is parsed as it grows.
 */
export function splitStable(text: string): { stable: string; tail: string } {
  let inFence = false
  const cuts: number[] = []
  let i = 0
  const lines = text.split('\n')
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n]
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence
    // A blank line outside a fence, after something: the text before it will not change.
    if (!inFence && line.trim() === '' && n > 0) cuts.push(i + line.length + 1)
    i += line.length + 1
  }
  // The cut must leave something after it: a break the text has only just reached is not one yet.
  const cut = [...cuts].reverse().find((c) => text.slice(c).trim() !== '') ?? 0
  return { stable: text.slice(0, cut), tail: text.slice(cut) }
}
