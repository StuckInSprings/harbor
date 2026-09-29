import type { Review, Suggestion, SuggestionState, Verdict } from '../../../shared/bridge'
import { db, id, now } from './connection'

/* --------------------------------------------------------------- reviews */

type Row = { id: string; conversation_id: string; verdict: string; summary: string; suggestions: string; created_at: number }

const toReview = (r: Row): Review => ({
  id: r.id,
  conversationId: r.conversation_id,
  verdict: r.verdict as Verdict,
  summary: r.summary,
  suggestions: (() => {
    try {
      return JSON.parse(r.suggestions) as Suggestion[]
    } catch {
      return []
    }
  })(),
  createdAt: r.created_at
})

export function addReview(conversationId: string, r: { verdict: Verdict; summary: string; suggestions: Suggestion[] }): Review {
  const row: Row = { id: id(), conversation_id: conversationId, verdict: r.verdict, summary: r.summary, suggestions: JSON.stringify(r.suggestions), created_at: now() }
  db.prepare('INSERT INTO reviews (id, conversation_id, verdict, summary, suggestions, created_at) VALUES (@id, @conversation_id, @verdict, @summary, @suggestions, @created_at)').run(row)
  return toReview(row)
}

/** A run's reviews, newest first. */
export function listReviews(conversationId: string): Review[] {
  return (db.prepare('SELECT * FROM reviews WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC').all(conversationId) as Row[]).map(toReview)
}

/** What the person did with one suggestion: sent it on to the director, or put it aside. */
export function setSuggestionState(reviewId: string, index: number, state: SuggestionState): Review | null {
  const row = db.prepare('SELECT * FROM reviews WHERE id = ?').get(reviewId) as Row | undefined
  if (!row) return null
  const review = toReview(row)
  if (!review.suggestions[index]) return review
  review.suggestions[index] = { ...review.suggestions[index], state }
  db.prepare('UPDATE reviews SET suggestions = ? WHERE id = ?').run(JSON.stringify(review.suggestions), reviewId)
  return review
}
