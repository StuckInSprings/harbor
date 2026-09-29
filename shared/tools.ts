/**
 * Whether a collapsed tool row should read as failed.
 *
 * Scoped to the row's own calls. Asking whether anything in the conversation
 * ever failed turns every row red once one call errors, which both loses the
 * information and spends the error colour on work that succeeded.
 */
export function toolRowFailed(
  calls: { callId: string; ok?: boolean }[],
  resultFor: (callId: string) => string | undefined
): boolean {
  return calls.some((c) => {
    if (c.ok === false) return true
    // Tool failures come back as text, since that is what the model reads.
    return (resultFor(c.callId) ?? '').startsWith('Error:')
  })
}
