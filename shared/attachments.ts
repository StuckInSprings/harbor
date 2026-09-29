import type { Attachment } from './types'

/**
 * Whether an attachment can actually be sent to a given model.
 *
 * This has to be decided when the prompt is built, not when the file is picked.
 * An image sits in the conversation for good, so a model that cannot read one
 * would be handed it again on every later turn — and a warning shown once, at
 * the composer, says nothing about the twentieth message in that conversation.
 */
export function canSendTo(a: Attachment, accepts: string[]): boolean {
  // PDFs work everywhere: OpenRouter's file-parser converts them server side.
  if (a.kind === 'pdf' || a.kind === 'text') return true
  if (a.kind === 'image') return accepts.includes('image')
  return true
}

/** What the model is told instead, so the gap in the conversation makes sense. */
export function noteForOmitted(a: Attachment): string {
  return `[${a.name} was attached here, but this model cannot read ${a.kind}s, so it was left out.]`
}

/** Attachments in a conversation that the chosen model would have to skip. */
export function unreadable(list: Attachment[], accepts: string[]): Attachment[] {
  return list.filter((a) => !canSendTo(a, accepts))
}
