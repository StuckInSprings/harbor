import { memo, useState, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { looksLikePath, openFile } from '../lib/fileLinks'
import { api } from '../lib/api'

/** Pull the plain text out of a rendered node tree, for the copy button. */
function textOf(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node === 'object' && 'props' in (node as any)) {
    return textOf((node as any).props?.children)
  }
  return ''
}

function CodeBlock({ children }: { children?: ReactNode }): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const code = textOf(children)

  const copy = async (): Promise<void> => {
    await navigator.clipboard.writeText(code)
    setCopied(true)
    setTimeout(() => setCopied(false), 1400)
  }

  return (
    <div className="codeblock">
      <pre>{children}</pre>
      <button className="codeblock__copy" onClick={copy}>
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  )
}

function Link({ href, children }: { href?: string; children?: ReactNode }): React.JSX.Element {
  const open = (e: React.MouseEvent): void => {
    e.preventDefault()
    if (!href) return
    // A web link goes to the browser; anything else is a path in the project.
    if (href.startsWith('https://')) void api.openExternal(href)
    else openFile(href.replace(/^\.\//, ''))
  }
  return (
    <a href={href} onClick={open}>
      {children}
    </a>
  )
}

/**
 * Inline code carrying a path becomes a link to it.
 *
 * A fenced block arrives here too, carrying a language-* class that the
 * highlighter put there — pass those straight through, or highlighting dies
 * quietly the moment this override is added.
 */
function InlineCode({
  className,
  children
}: {
  className?: string
  children?: ReactNode
}): React.JSX.Element {
  const text = textOf(children)
  if (className || !looksLikePath(text)) return <code className={className}>{children}</code>

  /*
    A real button, not a code element wearing role="button". The latter never
    reaches the accessibility tree, so it is invisible to a screen reader and
    unreachable by keyboard — a clickable thing nobody can find.
  */
  return (
    <button className="code-path" title={`Open ${text}`} onClick={() => openFile(text)} aria-label={`Open ${text}`}>
      <code>{children}</code>
    </button>
  )
}

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="prose">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
        components={{ pre: CodeBlock, a: Link, code: InlineCode }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
})
