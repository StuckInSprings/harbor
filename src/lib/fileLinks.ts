/**
 * File references in the transcript.
 *
 * The model writes paths constantly — in links, and far more often in inline
 * code. Making them open in the inspector is the difference between reading
 * about a file and reading the file. Markdown is rendered in two different
 * places, so the handler is registered once here rather than threaded through
 * every component between.
 */

let handler: ((path: string) => void) | null = null

export function setFileOpener(fn: (path: string) => void): void {
  handler = fn
}

export function openFile(path: string): void {
  handler?.(path)
}

/**
 * Extensions rather than a shape test, because a shape test cannot tell
 * `docs/BUNDLE.md` from `module.exports` — both are a dotted word with no
 * spaces, and only one of them is a file.
 */
const EXTENSIONS = new Set([
  'md', 'markdown', 'mdx', 'txt', 'rst', 'csv', 'tsv',
  'json', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'lock', 'env',
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'rb', 'go', 'rs', 'java',
  'c', 'h', 'cpp', 'hpp', 'cs', 'swift', 'kt', 'php', 'sh', 'bash', 'zsh',
  'sql', 'css', 'scss', 'html', 'xml', 'svg', 'vue', 'svelte',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'pdf'
])

export function looksLikePath(text: string): boolean {
  const t = text.trim()
  if (!t || t.length > 200 || /\s/.test(t)) return false
  if (t.startsWith('http://') || t.startsWith('https://')) return false
  const ext = t.slice(t.lastIndexOf('.') + 1).toLowerCase()
  return t.includes('.') && EXTENSIONS.has(ext)
}
