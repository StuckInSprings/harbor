import type { Attachment } from '../../shared/types'
import { useThumbnail } from '../lib/thumbnails'
import { Cross } from './Icons'

/**
 * An image shows itself. A filename like "Pasted 2026-09-08T14-32-01.png" says
 * nothing about what was actually pasted, so the thumbnail is the label —
 * anything else keeps the name, which for a PDF or a text file is the useful
 * part.
 */
export function AttachmentChip({
  attachment,
  onRemove
}: {
  attachment: Attachment
  onRemove?: (hash: string) => void
}): React.JSX.Element {
  const url = useThumbnail(attachment)

  if (attachment.kind === 'image') {
    return (
      <span className="thumb" title={attachment.name}>
        {url ? (
          <img className="thumb__img" src={url} alt={attachment.name} />
        ) : (
          <span className="thumb__loading" />
        )}
        {onRemove && (
          <button
            className="thumb__x"
            onClick={() => onRemove(attachment.hash)}
            title={`Remove ${attachment.name}`}
           aria-label={`Remove ${attachment.name}`}>
            <Cross size={10} />
          </button>
        )}
      </span>
    )
  }

  return (
    <span className="att" data-kind={attachment.kind}>
      <span className="att__kind sounding">{attachment.kind}</span>
      <span className="att__name">{attachment.name}</span>
      {onRemove && (
        <button
          className="att__x"
          onClick={() => onRemove(attachment.hash)}
          title={`Remove ${attachment.name}`}
         aria-label={`Remove ${attachment.name}`}>
          <Cross size={10} />
        </button>
      )}
    </span>
  )
}
