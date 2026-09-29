import type { Attachment } from '../../shared/types'
import { notify } from './notices'

/**
 * Pasted and dropped files.
 *
 * Both arrive as browser File or Blob objects, so both take the same route:
 * read the bytes here and hand them to the main process, which classifies and
 * stores them exactly as it does a file chosen from the dialog. Electron no
 * longer exposes a path on dropped files, so bytes are the only reliable
 * common ground anyway.
 */

/** Chunked, because a spread over a multi-megabyte array blows the call stack. */
function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

const stamp = (): string =>
  new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)

const extFor = (mime: string): string => mime.split('/')[1]?.split('+')[0] ?? 'bin'

export async function ingestFiles(files: File[]): Promise<Attachment[]> {
  const out: Attachment[] = []
  for (const file of files) {
    try {
      // A pasted screenshot has no useful name, so give it a datestamped one.
      const name = file.name || `Pasted ${stamp()}.${extFor(file.type)}`
      const r = await window.harbor.attachments.ingestData(
        name,
        file.type,
        toBase64(await file.arrayBuffer())
      )
      if (r.ok && r.data) out.push(r.data)
      else notify(r.error ?? `${name} could not be attached.`)
    } catch (e) {
      notify((e as Error).message)
    }
  }
  return out
}
