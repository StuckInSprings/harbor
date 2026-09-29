/**
 * Turning an OpenRouter error into something worth reading.
 *
 * Errors arrive in one shape whether they come back as a status or mid-stream
 * with HTTP 200 and finish_reason "error", and the useful part is rarely the
 * status. metadata.error_type is a canonical code, provider_code is what the
 * upstream provider itself said, and a moderation refusal carries the reasons
 * and the text that tripped it. Reporting only "Request failed (400)" throws
 * all of that away.
 */

export interface ProviderError {
  code?: number
  message?: string
  metadata?: {
    error_type?: string
    provider_code?: string
    provider_name?: string
    model_slug?: string
    reasons?: string[]
    flagged_input?: string
    patterns?: string[]
    raw?: unknown
  }
}

/** Pulls the error out of a response body or a mid-stream chunk. */
export function parseError(body: unknown): ProviderError | null {
  if (typeof body === 'string') {
    try {
      return parseError(JSON.parse(body))
    } catch {
      return body.trim() ? { message: body.trim().slice(0, 300) } : null
    }
  }
  if (!body || typeof body !== 'object') return null
  const e = (body as { error?: unknown }).error
  return e && typeof e === 'object' ? (e as ProviderError) : null
}

const BY_TYPE: Record<string, (who: string) => string> = {
  context_length_exceeded: () =>
    'This conversation is longer than the model accepts. Start a new one, or pick a model with a larger context window.',
  max_tokens_exceeded: () => 'The reply limit is larger than this model allows. Lower it in the parameters.',
  token_limit_exceeded: () => 'This request is over the model token limit.',
  payload_too_large: () => 'This request is too large to send. An attachment is the usual cause.',
  authentication: () => 'OpenRouter rejected the key. Check it in Settings.',
  permission_denied: (who) => `${who} refused this request.`,
  payment_required: () => 'Out of credit on this OpenRouter account.',
  rate_limit_exceeded: (who) => `Rate limited by ${who}. Wait a moment and try again.`,
  provider_overloaded: (who) => `${who} is overloaded. Try again, or pick another model.`,
  provider_unavailable: (who) => `${who} is unavailable. Pick another model.`,
  timeout: (who) => `${who} took too long to answer.`,
  content_policy_violation: (who) => `${who} refused this on content grounds.`,
  refusal: (who) => `${who} declined to answer this.`,
  invalid_image: () => 'That image could not be read. Try a different file.',
  image_too_large: () => 'That image is too large for this model.',
  image_too_small: () => 'That image is too small for this model.',
  unsupported_image_format: () => 'This model does not accept that image format.',
  image_download_failed: () => 'The image could not be fetched.',
  invalid_prompt: () => 'The model rejected the prompt as malformed.',
  not_found: () => 'That model does not exist, or is no longer offered.',
  server: (who) => `${who} hit an internal error.`
}

const BY_STATUS: Record<number, string> = {
  400: 'OpenRouter rejected the request as malformed.',
  401: 'OpenRouter rejected the key. Check it in Settings.',
  402: 'Out of credit on this OpenRouter account.',
  403: 'This request was blocked before it reached the model.',
  404: 'That model does not exist, or is no longer offered.',
  408: 'The request timed out.',
  429: 'Rate limited. Wait a moment and try again.',
  502: 'The model returned something OpenRouter could not read.',
  503: 'No provider could take this request right now.',
  504: 'The provider did not answer in time.'
}

/*
  A mid-stream chunk names the provider at the top level rather than inside
  the error, so both places have to be read before falling back.
*/
function providerOf(body: unknown, err: ProviderError | null): string | undefined {
  const named = err?.metadata?.provider_name
  if (named) return named
  const top = (body as { provider?: unknown } | null)?.provider
  return typeof top === 'string' && top ? top : undefined
}

/** A sentence to show, built from the most specific thing available. */
export function describeError(status: number | undefined, body: unknown): string {
  const err = parseError(body)
  const meta = err?.metadata ?? {}
  const who = providerOf(body, err) || 'The provider'

  const parts: string[] = []

  const typed = meta.error_type ? BY_TYPE[meta.error_type] : undefined
  if (typed) parts.push(typed(who))
  else if (status && BY_STATUS[status]) parts.push(BY_STATUS[status])
  else if (err?.message) parts.push(err.message)
  else parts.push('The request failed.')

  // A moderation refusal is only actionable if it says what tripped it.
  if (meta.reasons?.length) parts.push(`Reasons: ${meta.reasons.join(', ')}.`)
  if (meta.flagged_input) parts.push(`Flagged: "${meta.flagged_input}"`)
  if (meta.patterns?.length) parts.push(`Detected: ${meta.patterns.join(', ')}.`)

  /*
    The provider's own message, when it says something the canonical code does
    not. Kept last and short, since it is often raw and unpolished.
  */
  const own = err?.message?.trim()
  if (own && !parts.some((p) => p.includes(own)) && own.length < 200 && !typed) {
    parts.push(`(${own})`)
  } else if (own && typed && own.length < 160 && !parts[0].includes(own)) {
    parts.push(`(${who} said: ${own})`)
  }
  if (meta.provider_code) parts.push(`[${meta.provider_code}]`)

  return parts.join(' ')
}

/** Everything worth putting in the log, flattened. */
export function errorDetail(status: number | undefined, body: unknown): Record<string, unknown> {
  const err = parseError(body)
  return {
    status: status ?? err?.code,
    type: err?.metadata?.error_type,
    provider: providerOf(body, err),
    providerCode: err?.metadata?.provider_code,
    model: err?.metadata?.model_slug,
    message: err?.message
  }
}
