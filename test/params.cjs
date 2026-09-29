const { app } = require('electron')

app.whenReady().then(() => {
  const { openrouter: OR, params: P } = require('../out/test/entry.cjs')
  let pass = 0, fail = 0
  const check = (label, ok, detail = '') => {
    console.log((ok ? 'ok    ' : 'FAIL  ') + label + (ok || !detail ? '' : ' -- ' + detail))
    ok ? pass++ : fail++
  }
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

  console.log('-- reasoning blocks merge as they stream --')
  const m1 = OR.mergeReasoningDetails([], [{ type: 'reasoning.text', text: 'Let me ', index: 0, format: 'anthropic-claude-v1' }])
  const m2 = OR.mergeReasoningDetails(m1, [{ type: 'reasoning.text', text: 'think.', index: 0, signature: 'sig', id: 'r1' }])
  check('pieces with one index join on their text', m2.length === 1 && m2[0].text === 'Let me think.' && m2[0].signature === 'sig' && m2[0].id === 'r1' && m2[0].format === 'anthropic-claude-v1', JSON.stringify(m2))
  const m3 = OR.mergeReasoningDetails(m2, [{ type: 'reasoning.encrypted', data: 'abc', index: 1 }])
  check('a new index is a new block, in order', m3.length === 2 && m3[1].data === 'abc')
  check('a block with no index is appended whole', OR.mergeReasoningDetails([], [{ type: 'reasoning.summary', summary: 's' }, { type: 'reasoning.summary', summary: 't' }]).length === 2)
  check('nothing to merge changes nothing', OR.mergeReasoningDetails(m3, undefined) === m3 && OR.mergeReasoningDetails(m3, 'x') === m3)

  console.log('-- wire names --')
  const wire = OR.samplingFor({
    temperature: 0.7, topP: 0.9, topK: 40, maxTokens: 500, seed: 42,
    frequencyPenalty: 0.5, presencePenalty: -0.5
  })
  check('maps to OpenRouter snake_case', eq(wire, {
    temperature: 0.7, top_p: 0.9, top_k: 40, max_tokens: 500, seed: 42,
    frequency_penalty: 0.5, presence_penalty: -0.5
  }), JSON.stringify(wire))

  check('unset keys are absent, not undefined',
    eq(OR.samplingFor({ temperature: 0 }), { temperature: 0 }),
    JSON.stringify(OR.samplingFor({ temperature: 0 })))
  check('zero is a value, not "unset"', 'temperature' in OR.samplingFor({ temperature: 0 }))
  check('nothing set sends nothing', eq(OR.samplingFor({}), {}))
  check('the creative samplers go out under their OpenRouter names',
    eq(OR.samplingFor({ minP: 0.05, topA: 0.2, repetitionPenalty: 1.1 }),
       { min_p: 0.05, top_a: 0.2, repetition_penalty: 1.1 }),
    JSON.stringify(OR.samplingFor({ minP: 0.05, topA: 0.2, repetitionPenalty: 1.1 })))
  check('and are dropped for a model that does not list them',
    eq(P.filterParams({ minP: 0.05, temperature: 1 }, { supportedParameters: ['temperature'], supportsReasoning: false }),
       { temperature: 1 }))
  check('and kept for one that does',
    eq(P.filterParams({ minP: 0.05, repetitionPenalty: 1.1 }, { supportedParameters: ['min_p', 'repetition_penalty'], supportsReasoning: false }),
       { minP: 0.05, repetitionPenalty: 1.1 }))

  console.log('\n-- reasoning shape --')
  check('off sends nothing', eq(OR.reasoningFor(false, { reasoningEffort: 'high' }), {}))
  check('effort rides inside reasoning',
    eq(OR.reasoningFor(true, { reasoningEffort: 'high' }), { reasoning: { enabled: true, effort: 'high' } }),
    JSON.stringify(OR.reasoningFor(true, { reasoningEffort: 'high' })))
  check('a token budget wins over effort',
    eq(OR.reasoningFor(true, { reasoningEffort: 'high', reasoningMaxTokens: 2000 }),
       { reasoning: { enabled: true, max_tokens: 2000 } }))
  check('on with no detail still enables',
    eq(OR.reasoningFor(true, {}), { reasoning: { enabled: true } }))

  console.log('\n-- only what the model advertises --')
  const gemini = { supportedParameters: ['temperature', 'top_p', 'max_tokens', 'seed', 'reasoning'], supportsReasoning: true }
  console.log('-- efforts a model lists --')
  const fable = { supportedParameters: ['reasoning'], supportsReasoning: true, reasoning: { mandatory: true, defaultEnabled: true, efforts: ['max', 'xhigh', 'high', 'medium', 'low'], defaultEffort: 'high' } }
  const glm = { supportedParameters: ['reasoning'], supportsReasoning: true, reasoning: { mandatory: false, defaultEnabled: false, efforts: [], defaultEffort: null } }
  check('a model offers exactly the efforts it lists', eq(P.effortsFor(fable), ['max', 'xhigh', 'high', 'medium', 'low']))
  check('a model that lists none offers none', eq(P.effortsFor(glm), []))
  check('a model with no listing gets the old three', eq(P.effortsFor(gemini), ['low', 'medium', 'high']))
  check('a model that cannot reason offers none', eq(P.effortsFor({ supportedParameters: [], supportsReasoning: false }), []))
  check('a listed effort is sent', eq(P.filterParams({ reasoningEffort: 'max' }, fable), { reasoningEffort: 'max' }))
  check('an unlisted effort is dropped', eq(P.filterParams({ reasoningEffort: 'none' }, fable), {}))
  check('a model with no efforts gets none', eq(P.filterParams({ reasoningEffort: 'high' }, glm), {}))
  check('the order is most to least', eq(P.EFFORT_ORDER.join(','), 'max,xhigh,high,medium,low,minimal,none'))
  const kept = P.filterParams(
    { temperature: 0.7, topP: 0.9, topK: 40, frequencyPenalty: 1, seed: 7, reasoningEffort: 'low' },
    gemini
  )
  check('drops top_k and frequency_penalty for this model',
    eq(kept, { temperature: 0.7, topP: 0.9, seed: 7, reasoningEffort: 'low' }),
    JSON.stringify(kept))

  const plain = { supportedParameters: ['max_tokens'], supportsReasoning: false }
  check('a model taking only max_tokens gets only that',
    eq(P.filterParams({ temperature: 1, maxTokens: 100, reasoningEffort: 'high' }, plain),
       { maxTokens: 100 }))

  console.log('\n-- conversation over project --')
  check('override wins key by key',
    eq(P.mergeParams({ temperature: 0.2, seed: 1 }, { temperature: 0.9 }),
       { temperature: 0.9, seed: 1 }))
  check('an empty override inherits everything',
    eq(P.mergeParams({ temperature: 0.2 }, {}), { temperature: 0.2 }))

  console.log('\n-- a tool row is red only for its own failure --')
  const T = require('../out/test/entry.cjs').tools
  const results = { a: 'Listed 4 entries', b: 'Error: no such file', c: 'Read 20 lines' }
  const at = (id) => results[id]

  check('a succeeding row is not marked failed',
    T.toolRowFailed([{ callId: 'a' }, { callId: 'c' }], at) === false)
  check('a failing row is marked failed',
    T.toolRowFailed([{ callId: 'b' }], at) === true)
  check('one failure elsewhere does not redden a good row',
    T.toolRowFailed([{ callId: 'a' }], at) === false)
  check('an explicit ok:false counts even with no result yet',
    T.toolRowFailed([{ callId: 'z', ok: false }], at) === true)
  check('a call still running is not failed',
    T.toolRowFailed([{ callId: 'z' }], at) === false)

  console.log('\n-- attachments a model cannot read --')
  const A = require('../out/test/entry.cjs').attach
  const img = { hash: 'h', name: 'shot.png', mime: 'image/png', kind: 'image', size: 1 }
  const pdf = { hash: 'p', name: 'spec.pdf', mime: 'application/pdf', kind: 'pdf', size: 1 }
  const txt = { hash: 't', name: 'notes.txt', mime: 'text/plain', kind: 'text', size: 1 }

  check('a vision model takes the image', A.canSendTo(img, ['text', 'image']) === true)
  check('a text-only model does not', A.canSendTo(img, ['text']) === false)
  check('a pdf goes to any model, since OpenRouter parses it',
    A.canSendTo(pdf, ['text']) === true)
  check('so does plain text', A.canSendTo(txt, ['text']) === true)
  check('only the unreadable ones are reported',
    JSON.stringify(A.unreadable([img, pdf, txt], ['text']).map((a) => a.name)) ===
      JSON.stringify(['shot.png']))
  check('and none when the model can read them',
    A.unreadable([img, pdf, txt], ['text', 'image']).length === 0)
  check('the note names the file and why', /shot\.png/.test(A.noteForOmitted(img)) &&
    /cannot read/.test(A.noteForOmitted(img)), A.noteForOmitted(img))

  console.log(`\n${pass} passed, ${fail} failed`)
  app.exit(fail === 0 ? 0 : 1)
}).catch((e) => { console.log('THREW ' + e.stack); app.exit(1) })
