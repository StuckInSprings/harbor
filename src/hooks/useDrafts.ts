import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'

const DRAFTS_KEY = 'harbor.drafts'
function readDrafts(): Record<string, string> {
  try {
    const raw = window.localStorage.getItem(DRAFTS_KEY)
    const parsed = raw ? (JSON.parse(raw) as unknown) : null
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {}
  } catch {
    return {}
  }
}
function writeDrafts(drafts: Record<string, string>): void {
  try {
    window.localStorage.setItem(DRAFTS_KEY, JSON.stringify(drafts))
  } catch {
    // Nowhere to keep them; they last the session.
  }
}

/**
 * Each conversation keeps its own draft, so switching away and back loses
 * nothing typed. Kept in the browser store too, so a relaunch keeps them.
 */
export function useDrafts(activeId: string | null, activeIdRef: RefObject<string | null>): {
  draft: string
  setDraft: (text: string) => void
  /** A draft written for a conversation before it is on screen: stored under its id, so the switch finds it. */
  prefill: (id: string, text: string) => void
} {
  const [draft, setDraft] = useState('')
  const draftsRef = useRef<Record<string, string>>(readDrafts())
  useEffect(() => {
    const id = activeIdRef.current
    if (!id) return
    if (draft) draftsRef.current[id] = draft
    else delete draftsRef.current[id]
    writeDrafts(draftsRef.current)
  }, [draft, activeIdRef])
  useEffect(() => {
    setDraft(activeId ? (draftsRef.current[activeId] ?? '') : '')
  }, [activeId])
  const prefill = useCallback((id: string, text: string): void => {
    draftsRef.current[id] = text
    writeDrafts(draftsRef.current)
    setDraft(text)
  }, [])
  return { draft, setDraft, prefill }
}
