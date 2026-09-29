/**
 * What kind of thing a path is, by its extension. Shared so the explorer,
 * the file viewer and the main process agree on what renders as an image
 * and what can be attached to a message.
 */

export const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp'
}

export const TEXT_EXTS = new Set([
  '.txt', '.md', '.markdown', '.mdx', '.json', '.yaml', '.yml', '.toml', '.csv', '.tsv',
  '.ts', '.tsx', '.js', '.jsx', '.py', '.rb', '.go', '.rs', '.java', '.sh', '.sql',
  '.css', '.html', '.xml', '.ini', '.cfg', '.log'
])

export const extOf = (path: string): string => {
  const name = path.replace(/\\/g, '/').split('/').pop() ?? ''
  const i = name.lastIndexOf('.')
  return i <= 0 ? '' : name.slice(i).toLowerCase()
}

export const imageMime = (path: string): string | null => IMAGE_MIME[extOf(path)] ?? null
export const isImage = (path: string): boolean => imageMime(path) !== null

/** Images, PDFs and text: what a message can carry. */
export const isAttachable = (path: string): boolean => {
  const ext = extOf(path)
  return ext in IMAGE_MIME || ext === '.pdf' || TEXT_EXTS.has(ext)
}

export const parentOf = (path: string): string => {
  const p = path.replace(/\\/g, '/')
  const i = p.lastIndexOf('/')
  return i === -1 ? '.' : p.slice(0, i) || '.'
}

export const joinPath = (dir: string, name: string): string =>
  dir === '.' || dir === '' ? name : `${dir.replace(/\/$/, '')}/${name}`

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
