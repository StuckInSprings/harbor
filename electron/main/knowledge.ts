import { promises as fs } from 'node:fs'
import { join, extname, relative, basename } from 'node:path'
import * as db from './db'
import { embed, asQuery, toBuffer, DIMENSIONS } from './embed'
import { hashOf } from './workspace'

/**
 * Knowledge is information that has been written down — see
 * docs/CONTEXT-MODEL.md. It is deliberately separate from the workspace: the
 * workspace is live code the agent edits, this is a curated read-only corpus it
 * cites.
 *
 * Retrieval fuses BM25 and vector similarity. Hybrid beats pure vector on the
 * exact-term queries that dominate technical work — a function name is looked
 * up, not paraphrased.
 */

const TEXT_EXTS = new Set([
  '.md', '.markdown', '.txt', '.rst', '.org', '.csv', '.tsv', '.json', '.yaml', '.yml',
  '.html', '.xml', '.toml', '.ini',
  '.ts', '.tsx', '.js', '.jsx', '.py', '.rb', '.go', '.rs', '.java', '.sql', '.sh'
])

/** Extracted rather than read, but otherwise indexed like any other document. */
const EXTRACTABLE_EXTS = new Set(['.pdf'])

const isIndexable = (path: string): boolean => {
  const ext = extname(path).toLowerCase()
  return TEXT_EXTS.has(ext) || EXTRACTABLE_EXTS.has(ext)
}

/**
 * PDFs go through a pure-JS extractor rather than OpenRouter's parser, so
 * indexing stays free and offline like the embeddings do. A PDF with no text
 * layer yields nothing, which is honest — it needs OCR, and that is a
 * different job.
 */
async function extractPdf(path: string): Promise<string> {
  const { extractText, getDocumentProxy } = await import('unpdf')
  const bytes = new Uint8Array(await fs.readFile(path))
  const pdf = await getDocumentProxy(bytes)
  const { text } = await extractText(pdf, { mergePages: true })
  return typeof text === 'string' ? text : ''
}

async function readIndexable(path: string): Promise<string | null> {
  if (EXTRACTABLE_EXTS.has(extname(path).toLowerCase())) {
    return extractPdf(path).catch(() => null)
  }
  return fs.readFile(path, 'utf8').catch(() => null)
}

const MAX_FILE_BYTES = 2 * 1024 * 1024
const TARGET_CHARS = 2000
const OVERLAP_CHARS = 200

export interface Chunk {
  relPath: string
  heading: string
  content: string
}

/**
 * Split on markdown headings first, so a chunk carries the heading trail that
 * makes its citation meaningful. Long sections are then cut with overlap.
 */
export function chunkText(text: string, relPath: string): Chunk[] {
  const lines = text.split('\n')
  const sections: { heading: string; body: string[] }[] = [{ heading: '', body: [] }]
  const trail: string[] = []

  for (const line of lines) {
    const h = /^(#{1,6})\s+(.*)$/.exec(line)
    if (h) {
      const depth = h[1].length
      trail.length = Math.max(0, depth - 1)
      trail[depth - 1] = h[2].trim()
      sections.push({ heading: trail.filter(Boolean).join(' › '), body: [] })
    } else {
      sections[sections.length - 1].body.push(line)
    }
  }

  const out: Chunk[] = []
  for (const section of sections) {
    const body = section.body.join('\n').trim()
    if (!body) continue

    if (body.length <= TARGET_CHARS) {
      out.push({ relPath, heading: section.heading, content: body })
      continue
    }
    for (let i = 0; i < body.length; i += TARGET_CHARS - OVERLAP_CHARS) {
      const piece = body.slice(i, i + TARGET_CHARS).trim()
      if (piece) out.push({ relPath, heading: section.heading, content: piece })
    }
  }
  return out
}

async function* walkSource(root: string, depth = 0): AsyncGenerator<string> {
  if (depth > 8) return
  const stat = await fs.stat(root).catch(() => null)
  if (!stat) return
  if (stat.isFile()) {
    if (isIndexable(root) && stat.size <= MAX_FILE_BYTES) yield root
    return
  }
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => [])
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue
    yield* walkSource(join(root, e.name), depth + 1)
  }
}

export interface IndexProgress {
  file: string
  done: number
  total: number
}

/** Re-indexes a source from scratch. Incremental by content hash per file. */
export async function indexSource(
  sourceId: string,
  projectId: string,
  sourcePath: string,
  onProgress?: (p: IndexProgress) => void
): Promise<{ files: number; chunks: number; skipped: number }> {
  const files: string[] = []
  for await (const f of walkSource(sourcePath)) files.push(f)

  const base = (await fs.stat(sourcePath)).isDirectory() ? sourcePath : join(sourcePath, '..')

  let chunkCount = 0
  let skipped = 0

  for (const [i, file] of files.entries()) {
    const relPath = relative(base, file) || basename(file)
    onProgress?.({ file: relPath, done: i, total: files.length })

    const text = await readIndexable(file)
    if (text === null || !text.trim()) continue

    const fileHash = hashOf(text)
    if (db.fileAlreadyIndexed(sourceId, relPath, fileHash)) {
      skipped++
      continue
    }

    db.clearChunksForFile(sourceId, relPath)
    const chunks = chunkText(text, relPath)
    if (chunks.length === 0) continue

    // Embedding the heading with the body helps short chunks retrieve well.
    const vectors = await embed(
      chunks.map((c) => (c.heading ? `${c.heading}\n\n${c.content}` : c.content))
    )

    chunks.forEach((c, j) => {
      db.addChunk(
        {
          sourceId,
          projectId,
          relPath: c.relPath,
          heading: c.heading,
          content: c.content,
          fileHash
        },
        toBuffer(vectors[j])
      )
    })
    chunkCount += chunks.length
  }

  db.pruneMissingFiles(
    sourceId,
    files.map((f) => relative(base, f) || basename(f))
  )
  db.touchSource(sourceId)
  return { files: files.length, chunks: chunkCount, skipped }
}

export interface Hit {
  relPath: string
  heading: string
  content: string
  score: number
  /** True when nothing matched strongly; the caller should say so. */
  weak?: boolean
}

/**
 * Reciprocal rank fusion. Combining ranks rather than raw scores avoids having
 * to normalise a BM25 score against a cosine distance, which is not meaningful.
 */
const RRF_K = 60

/*
  Nearest-neighbour search always returns something, so a question about
  nothing in the corpus still comes back with its least-bad matches, which then
  waste context and can mislead.

  Measured on this project's own docs with bge-small: a relevant paraphrase
  lands at 0.91-0.94, an exact term at 0.96-1.00, nonsense at 1.03-1.05 and an
  off-topic question at 1.04-1.06. The bands separate, but only by a few
  percent, and those absolutes will drift with corpus and model. So the cutoff
  is treated as a heuristic rather than a guarantee: anything past MAX_DISTANCE
  is dropped, and anything merely close to it is still returned but labelled, so
  a model can disregard it rather than dutifully citing noise.
*/
const MAX_DISTANCE = 1.02
const WEAK_DISTANCE = 0.98

export async function search(projectId: string, query: string, k = 6): Promise<Hit[]> {
  const lexical = db.searchChunksLexical(projectId, query, k * 3)

  let semantic: { id: number; distance: number }[] = []
  try {
    const [vector] = await embed([asQuery(query)])
    if (vector) {
      semantic = db
        .searchChunksVector(projectId, toBuffer(vector), k * 3)
        .filter((r) => r.distance <= MAX_DISTANCE)
    }
  } catch {
    // No embedder available: lexical results are still worth returning.
  }

  const bestDistance = semantic.length ? semantic[0].distance : Infinity
  const weak = lexical.length === 0 && bestDistance > WEAK_DISTANCE

  const scores = new Map<number, number>()
  lexical.forEach((row, rank) => {
    scores.set(row.id, (scores.get(row.id) ?? 0) + 1 / (RRF_K + rank + 1))
  })
  semantic.forEach((row, rank) => {
    scores.set(row.id, (scores.get(row.id) ?? 0) + 1 / (RRF_K + rank + 1))
  })

  const top = [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, k)
  const hits: Hit[] = []
  for (const [id, score] of top) {
    const row = db.getChunk(id)
    if (row) hits.push({ ...row, score, weak })
  }
  return hits
}

/** What the model gets back: cited, and short enough to stay affordable. */
export function formatHits(hits: Hit[]): string {
  if (hits.length === 0) return 'No matching passages in this project knowledge.'

  const body = hits
    .map((h, i) => {
      const where = h.heading ? `${h.relPath} › ${h.heading}` : h.relPath
      return `[${i + 1}] ${where}\n${h.content}`
    })
    .join('\n\n---\n\n')

  return hits[0].weak
    ? `Nothing here matches that closely. The passages below are the nearest, but they may be beside the point — say so rather than citing them as answers.\n\n${body}`
    : body
}

export { DIMENSIONS }
