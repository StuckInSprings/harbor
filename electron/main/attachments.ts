import { extname, basename } from 'node:path'
import { promises as fs } from 'node:fs'
import type { Attachment } from '../../shared/types'
import * as blobs from './blobs'

/**
 * Files attached to a single message.
 *
 * Three kinds, because OpenRouter wants three different things:
 *   image  -> an image_url content part, which needs a vision model
 *   pdf    -> a file content part plus the file-parser plugin, which works on
 *             every model because OpenRouter parses server side
 *   text   -> inlined directly, which needs nothing and costs nothing
 */

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp'
}

const TEXT_EXTS = new Set([
  '.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.yaml', '.yml', '.xml',
  '.html', '.css', '.ts', '.tsx', '.js', '.jsx', '.py', '.rb', '.go', '.rs',
  '.java', '.c', '.h', '.cpp', '.sh', '.sql', '.toml', '.ini', '.log'
])

/** Base64 of a large image balloons both the request and the token bill. */
const MAX_BYTES = 8 * 1024 * 1024

const KIND_BY_MIME = (mime: string): Attachment['kind'] | null => {
  if (Object.values(IMAGE_MIME).includes(mime)) return 'image'
  if (mime === 'application/pdf') return 'pdf'
  if (mime.startsWith('text/') || mime === 'application/json') return 'text'
  return null
}

/**
 * Pasted and dropped content arrives as bytes with no path on disk, so it is
 * classified by mime type rather than extension. Everything downstream is the
 * same as a file picked from the dialog.
 */
export async function ingestBytes(
  name: string,
  mime: string,
  data: Buffer
): Promise<Attachment> {
  if (data.byteLength > MAX_BYTES) {
    throw new Error(
      `That ${Math.round(data.byteLength / 1024 / 1024)}MB paste is larger than the 8MB Harbor attaches.`
    )
  }
  const kind = KIND_BY_MIME(mime)
  if (!kind) {
    throw new Error(`Harbor cannot attach ${mime || 'that'}. Images, PDFs and text work.`)
  }
  const hash = await blobs.put(data)
  return { hash, name, mime, kind, size: data.byteLength }
}

export async function ingest(path: string): Promise<Attachment> {
  const stat = await fs.stat(path)
  if (stat.size > MAX_BYTES) {
    throw new Error(
      `${basename(path)} is ${Math.round(stat.size / 1024 / 1024)}MB. Harbor attaches files up to 8MB.`
    )
  }

  const ext = extname(path).toLowerCase()
  const data = await fs.readFile(path)
  const hash = await blobs.put(data)

  if (IMAGE_MIME[ext]) {
    return { hash, name: basename(path), mime: IMAGE_MIME[ext], kind: 'image', size: stat.size }
  }
  if (ext === '.pdf') {
    return { hash, name: basename(path), mime: 'application/pdf', kind: 'pdf', size: stat.size }
  }
  if (TEXT_EXTS.has(ext)) {
    return { hash, name: basename(path), mime: 'text/plain', kind: 'text', size: stat.size }
  }
  throw new Error(
    `Harbor does not know what to do with ${ext || 'that file'}. Images, PDFs and text files work.`
  )
}

/** The content parts for one attachment, in OpenRouter's schema. */
export async function toContentPart(a: Attachment): Promise<unknown | null> {
  const data = await blobs.getBuffer(a.hash)
  if (!data) return null

  if (a.kind === 'image') {
    return {
      type: 'image_url',
      image_url: { url: `data:${a.mime};base64,${data.toString('base64')}` }
    }
  }
  if (a.kind === 'pdf') {
    return {
      type: 'file',
      file: {
        filename: a.name,
        file_data: `data:application/pdf;base64,${data.toString('base64')}`
      }
    }
  }
  // Text needs no special handling at all — it is just more prompt.
  return { type: 'text', text: `--- ${a.name} ---\n${data.toString('utf8')}` }
}

export const needsFileParser = (list: Attachment[]): boolean =>
  list.some((a) => a.kind === 'pdf')

export const needsVision = (list: Attachment[]): boolean =>
  list.some((a) => a.kind === 'image')
