import { useEffect, useState } from 'react'
import type { Attachment } from '../../shared/types'

/**
 * Attachment bytes live in the blob store, so showing one means fetching it
 * back across IPC. Blobs are content-addressed and immutable, so the result is
 * cached for the life of the window — the same image pasted twice, or shown in
 * both the composer and the transcript, is read once.
 */
const cache = new Map<string, string>()
const inFlight = new Map<string, Promise<string | null>>()

async function load(a: Attachment): Promise<string | null> {
  const cached = cache.get(a.hash)
  if (cached) return cached

  const pending = inFlight.get(a.hash)
  if (pending) return pending

  const p = (async () => {
    const r = await window.harbor.attachments.read(a.hash)
    if (!r.ok || !r.data) return null
    const url = `data:${a.mime};base64,${r.data}`
    cache.set(a.hash, url)
    return url
  })().finally(() => inFlight.delete(a.hash))

  inFlight.set(a.hash, p)
  return p
}

/** A data URL for an image attachment, or null while it loads or if it is not one. */
export function useThumbnail(a: Attachment): string | null {
  const [url, setUrl] = useState<string | null>(
    a.kind === 'image' ? (cache.get(a.hash) ?? null) : null
  )

  useEffect(() => {
    if (a.kind !== 'image' || cache.has(a.hash)) return
    let live = true
    void load(a).then((u) => {
      if (live) setUrl(u)
    })
    return () => {
      live = false
    }
  }, [a.hash, a.kind, a])

  return url
}
