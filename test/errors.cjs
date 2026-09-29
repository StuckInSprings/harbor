const { app } = require('electron')

app.whenReady().then(() => {
  const { errors: E } = require('../out/test/entry.cjs')
  let pass = 0, fail = 0
  const check = (label, ok, detail = '') => {
    console.log((ok ? 'ok    ' : 'FAIL  ') + label + (ok || !detail ? '' : ' -- ' + detail))
    ok ? pass++ : fail++
  }
  const has = (s, ...bits) => bits.every((b) => s.includes(b))

  console.log('-- typed codes beat the status --')
  const ctx = E.describeError(400, JSON.stringify({
    error: { code: 400, message: 'too long',
      metadata: { error_type: 'context_length_exceeded', provider_name: 'Anthropic' } }
  }))
  check('context length says what to do', has(ctx, 'longer than', 'context window'), ctx)

  const rate = E.describeError(429, JSON.stringify({
    error: { code: 429, message: 'slow down',
      metadata: { error_type: 'rate_limit_exceeded', provider_name: 'Together', provider_code: 'rl_9' } }
  }))
  check('rate limit names the provider', has(rate, 'Together', 'Rate limited'), rate)
  check('and carries the provider code', has(rate, 'rl_9'), rate)

  console.log('\\n-- the image failures we hit --')
  for (const [type, bit] of [
    ['unsupported_image_format', 'image format'],
    ['image_too_large', 'too large'],
    ['invalid_image', 'could not be read']
  ]) {
    const m = E.describeError(400, { error: { code: 400, metadata: { error_type: type } } })
    check(`${type} is explained`, m.includes(bit), m)
  }

  console.log('\\n-- moderation says what tripped it --')
  const mod = E.describeError(403, {
    error: { code: 403, message: 'flagged', metadata: {
      error_type: 'content_policy_violation', provider_name: 'OpenAI',
      reasons: ['violence'], flagged_input: 'the offending words' } }
  })
  check('names the provider, reason and text',
    has(mod, 'OpenAI', 'violence', 'the offending words'), mod)

  console.log('\\n-- mid-stream errors carry a 200 --')
  const chunk = { provider: 'DeepInfra', error: { code: 502, message: 'upstream died',
    metadata: { error_type: 'provider_unavailable', provider_name: 'DeepInfra' } } }
  check('read from the body, not the status',
    E.describeError(chunk.error.code, chunk).includes('DeepInfra'),
    E.describeError(chunk.error.code, chunk))
  check('detail is flattened for the log',
    E.errorDetail(502, chunk).type === 'provider_unavailable' &&
    E.errorDetail(502, chunk).provider === 'DeepInfra')

  const topLevel = { provider: 'Fireworks', error: { code: 429,
    metadata: { error_type: 'rate_limit_exceeded' } } }
  check('the provider named at the top level is still found',
    E.describeError(429, topLevel).includes('Fireworks') &&
    E.errorDetail(429, topLevel).provider === 'Fireworks',
    E.describeError(429, topLevel))

  console.log('\\n-- degrades rather than losing the message --')
  check('an unknown type falls back to the status',
    E.describeError(503, { error: { code: 503, metadata: { error_type: 'something_new' } } })
      .includes('No provider'),
    E.describeError(503, { error: { code: 503, metadata: { error_type: 'something_new' } } }))
  check('a bare string body still says something',
    E.describeError(500, 'upstream exploded').length > 5,
    E.describeError(500, 'upstream exploded'))
  check('an empty body does not produce an empty message',
    E.describeError(undefined, '').length > 5, E.describeError(undefined, ''))

  console.log(`\\n${pass} passed, ${fail} failed`)
  app.exit(fail === 0 ? 0 : 1)
}).catch((e) => { console.log('THREW ' + e.stack); app.exit(1) })
