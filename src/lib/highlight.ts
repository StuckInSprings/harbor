import { common, createLowlight } from 'lowlight'
import type { Root, RootContent } from 'hast'

/**
 * Syntax highlighting for the editor, from the same highlighter the rendered
 * view already uses (rehype-highlight rides on lowlight), so the two agree
 * and nothing new is bundled.
 */
const lowlight = createLowlight(common)

/** highlight.js grammar for a file, by extension; null means plain text. */
const BY_EXT: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.mts': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.json': 'json',
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.mdx': 'markdown',
  '.py': 'python',
  '.rb': 'ruby',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.kt': 'kotlin',
  '.swift': 'swift',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.cs': 'csharp',
  '.sh': 'bash',
  '.zsh': 'bash',
  '.bash': 'bash',
  '.sql': 'sql',
  '.css': 'css',
  '.scss': 'scss',
  '.html': 'xml',
  '.xml': 'xml',
  '.svg': 'xml',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.toml': 'ini',
  '.ini': 'ini',
  '.php': 'php',
  '.lua': 'lua',
  '.diff': 'diff',
  '.dockerfile': 'dockerfile'
}

export function languageFor(path: string): string | null {
  const name = path.replace(/\\/g, '/').split('/').pop() ?? ''
  if (/^dockerfile$/i.test(name)) return 'dockerfile'
  const i = name.lastIndexOf('.')
  const lang = i <= 0 ? null : (BY_EXT[name.slice(i).toLowerCase()] ?? null)
  return lang && lowlight.registered(lang) ? lang : null
}

/** A hast tree of the highlighted code, or the code as one text node when unhighlighted. */
export function highlight(code: string, language: string | null): Root {
  if (language) {
    try {
      return lowlight.highlight(language, code)
    } catch {
      // A grammar that throws on odd input still leaves the text readable.
    }
  }
  return { type: 'root', children: [{ type: 'text', value: code }] }
}

/** Flatten a hast tree to `[className[], text]` runs — what a renderer needs and nothing else. */
export function runs(tree: Root): { classes: string[]; text: string }[] {
  const out: { classes: string[]; text: string }[] = []
  const walk = (nodes: RootContent[], classes: string[]): void => {
    for (const n of nodes) {
      if (n.type === 'text') out.push({ classes, text: n.value })
      else if (n.type === 'element') {
        const cls = n.properties?.className
        const own = Array.isArray(cls) ? cls.map(String) : typeof cls === 'string' ? [cls] : []
        walk(n.children as RootContent[], [...classes, ...own])
      }
    }
  }
  walk(tree.children, [])
  return out
}
