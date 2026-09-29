import { useEffect, useImperativeHandle, useRef, forwardRef } from 'react'
import { EditorContent, useEditor, type Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { Markdown } from '@tiptap/markdown'
import { Placeholder } from '@tiptap/extension-placeholder'
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight'
import { createLowlight, common } from 'lowlight'

/**
 * The box you type in, as a small block editor. A dash and a space start a
 * list, three backticks start a code block you can type code into, a hash
 * starts a heading, stars make bold; what is shown is what the words mean.
 * What leaves the box is Markdown, so the model reads exactly what it read
 * from the plain box before, and the transcript renders it the same way.
 *
 * Enter sends, except inside a code block or a list, where it does what
 * Enter does there; Shift+Enter is a line break anywhere; ⌘Enter always
 * sends. Escape and the arrows are the caller's when a menu is open.
 */

export interface RichInputHandle {
  focus: () => void
  /** The editor itself, for a test harness or a caller that must insert. */
  editor: Editor | null
}

const lowlight = createLowlight(common)

interface Props {
  value: string
  onChange: (markdown: string) => void
  onSubmit: () => void
  /** Keys a menu above the box owns while it is open; the editor leaves them alone. */
  ownedKeys: (key: string) => boolean
  onPasteFiles: (files: File[]) => void
  placeholder: string
  disabled: boolean
}

export const RichInput = forwardRef<RichInputHandle, Props>(function RichInput({ value, onChange, onSubmit, ownedKeys, onPasteFiles, placeholder, disabled }, ref) {
  const latest = useRef({ onChange, onSubmit, ownedKeys, onPasteFiles })
  latest.current = { onChange, onSubmit, ownedKeys, onPasteFiles }
  const placeholderRef = useRef(placeholder)
  placeholderRef.current = placeholder

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ codeBlock: false, heading: { levels: [1, 2, 3] }, link: { openOnClick: false, autolink: true } }),
      CodeBlockLowlight.configure({ lowlight, enableTabIndentation: true, tabSize: 2 }),
      Markdown,
      Placeholder.configure({ placeholder: () => placeholderRef.current })
    ],
    editorProps: {
      attributes: { class: 'composer__input composer__input--rich', spellcheck: 'true' },
      handleKeyDown: (view, event) => {
        if (latest.current.ownedKeys(event.key)) return true
        if (event.key !== 'Enter') return false
        const mod = event.metaKey || event.ctrlKey
        if (mod) {
          latest.current.onSubmit()
          return true
        }
        if (event.shiftKey) return false
        // Inside code or a list, Enter is a newline or a new item, as it is anywhere else that renders them.
        const { $from } = view.state.selection
        for (let d = $from.depth; d > 0; d--) {
          const name = $from.node(d).type.name
          if (name === 'codeBlock' || name === 'listItem' || name === 'taskItem' || name === 'blockquote') return false
        }
        latest.current.onSubmit()
        return true
      },
      handlePaste: (_view, event) => {
        const items = Array.from(event.clipboardData?.files ?? [])
        if (items.length === 0) return false
        latest.current.onPasteFiles(items)
        // Rich content often carries an image and its text together; the text lands, the image is attached.
        return !event.clipboardData?.types.includes('text/plain')
      }
    },
    onUpdate: ({ editor }) => latest.current.onChange(editor.getMarkdown()),
    onCreate: ({ editor }) => {
      /*
        The serialiser would backslash-escape stars, underscores and brackets
        and encode ampersands, so "a_b & c" left the box as "a\_b &amp; c".
        The words go out as typed: the plain box never rewrote them, and the
        model should not have to read past the punctuation.
      */
      const manager = (editor.storage as unknown as { markdown?: { manager?: { encodeTextForMarkdown?: (t: string) => string } } }).markdown?.manager
      if (manager) manager.encodeTextForMarkdown = (text: string) => text
      if (value) editor.commands.setContent(value, { contentType: 'markdown' })
    }
  })
  // What the caller sets from outside (a prompt filled in, the box emptied after a send) replaces what is in the box.
  useEffect(() => {
    if (!editor) return
    if (editor.getMarkdown() !== value) editor.commands.setContent(value, { contentType: 'markdown' })
  }, [value, editor])

  useEffect(() => {
    editor?.setEditable(!disabled)
  }, [editor, disabled])

  useImperativeHandle(ref, () => ({ focus: () => editor?.commands.focus('end'), editor: editor ?? null }), [editor])

  /*
    The box takes the caret the moment it exists. The editor is made after
    the first render, so a focus asked for on mount found nothing to focus
    and a fresh window, the quick question's above all, opened with the
    caret nowhere.
  */
  // The box is disabled until the key check answers, so the caret follows it when it opens.
  useEffect(() => {
    if (editor && !disabled) editor.commands.focus('end')
  }, [editor, disabled])

  // For the screen walk and any harness: the editor by name, so text can be put in it as Markdown.
  useEffect(() => {
    ;(window as unknown as { __composerEditor?: Editor | null }).__composerEditor = editor
  }, [editor])

  return <EditorContent editor={editor} />
})
