/**
 * A line diff, small enough to live here. LCS over lines is plenty for the
 * sizes an edit or a draft touches, and having one implementation means the
 * Changes pane and the draft history show the same thing for the same input.
 */

export type DiffLine = { kind: ' ' | '+' | '-'; text: string }

export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split('\n')
  const b = after.split('\n')
  const table: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0)
  )
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i][j] =
        a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1])
    }
  }
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: ' ', text: a[i] })
      i++
      j++
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      out.push({ kind: '-', text: a[i++] })
    } else {
      out.push({ kind: '+', text: b[j++] })
    }
  }
  while (i < a.length) out.push({ kind: '-', text: a[i++] })
  while (j < b.length) out.push({ kind: '+', text: b[j++] })
  return out
}

/** Collapse long runs of unchanged lines so a diff stays readable. */
export function withContext(lines: DiffLine[], context = 3): DiffLine[] {
  const keep = new Set<number>()
  lines.forEach((l, i) => {
    if (l.kind === ' ') return
    for (let k = i - context; k <= i + context; k++) if (k >= 0 && k < lines.length) keep.add(k)
  })
  const out: DiffLine[] = []
  let skipped = 0
  lines.forEach((l, i) => {
    if (keep.has(i)) {
      if (skipped) {
        out.push({ kind: ' ', text: `... ${skipped} unchanged lines` })
        skipped = 0
      }
      out.push(l)
    } else skipped++
  })
  if (skipped) out.push({ kind: ' ', text: `... ${skipped} unchanged lines` })
  return out
}

/** How much changed, for a version row: +added −removed. */
export function changeCounts(lines: DiffLine[]): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const l of lines) {
    if (l.kind === '+') added++
    else if (l.kind === '-') removed++
  }
  return { added, removed }
}
