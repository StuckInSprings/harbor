const { app } = require('electron')
const path = require('path')
const fs = require('fs')

const TMP = '/tmp/harbor-turn-test'
fs.rmSync(TMP, { recursive: true, force: true })
fs.mkdirSync(TMP, { recursive: true })
app.setPath('userData', TMP)

app.whenReady().then(async () => {
  const { db, run, openrouter: OR } = require('../out/test/entry.cjs')
  let pass = 0, fail = 0
  const check = (label, ok, detail = '') => {
    console.log((ok ? 'ok    ' : 'FAIL  ') + label + (ok || !detail ? '' : ' -- ' + detail))
    ok ? pass++ : fail++
  }

  db.initDb()
  const project = db.createProject('turns', null)
  const conv = db.createConversation(project.id, 'some/model')
  const user = db.addMessage(conv.id, null, 'user', 'hello', null)

  /*
    The invariant that was broken: a turn must always finish by telling the
    renderer something. Without a key the request cannot even be built, which
    is the cheapest way to make one fail.
  */
  const collect = async (opts) => {
    const events = []
    await run.runTurn(
      { requestId: 'r-' + Math.random(), conversationId: conv.id, parentId: user.id,
        model: 'some/model', agent: false, web: false, reasoning: false, params: {}, ...opts },
      (e) => events.push(e),
      () => {}
    )
    return events
  }

  let threw = false
  let events = []
  try {
    events = await collect({})
  } catch (e) {
    threw = true
  }

  check('a failing turn does not reject', threw === false)
  check('it emits a terminal event',
    events.some((e) => e.type === 'error' || e.type === 'done'),
    JSON.stringify(events.map((e) => e.type)))

  const err = events.find((e) => e.type === 'error')
  check('the error says something useful', !!err && err.message.length > 10,
    err ? err.message : 'no error event')
  check('it mentions the key, which is what is actually wrong',
    !!err && /key/i.test(err.message), err ? err.message : '')
  const failedRow = db.listMessages(conv.id).filter((m) => m.role === 'assistant').pop()
  check('main writes the failure onto the reply row itself',
    !!failedRow && /key/i.test(failedRow.error ?? ''), failedRow ? JSON.stringify({ content: failedRow.content, error: failedRow.error }) : 'no assistant row')

  // A conversation that does not exist must not wedge either.
  let threw2 = false
  let events2 = []
  try {
    events2 = await collect({ conversationId: 'nope', parentId: null })
  } catch {
    threw2 = true
  }
  check('an unknown conversation does not reject', threw2 === false)
  check('and still reports',
    events2.some((e) => e.type === 'error' || e.type === 'done'),
    JSON.stringify(events2.map((e) => e.type)))

  console.log('\n-- reasoning blocks go back to the model that made them --')
  const row = (extra) => ({ id: 'm', conversationId: conv.id, parentId: null, role: 'assistant', content: 'so', model: 'a/x', reasoning: 'thought', reasoningDetails: JSON.stringify([{ type: 'reasoning.text', text: 'thought', index: 0 }]), error: null, toolCalls: null, toolCallId: null, summaryOf: null, citations: null, attachments: null, promptTokens: null, completionTokens: null, cachedTokens: null, cacheWriteTokens: null, prefixHash: null, reasoningTokens: null, cost: null, createdAt: 0, ...extra })
  check('the same model gets its blocks back', Array.isArray(run.toWire(row({}), 'a/x').reasoning_details))
  check('with its tool calls', Array.isArray(run.toWire(row({ toolCalls: '[]' }), 'a/x').reasoning_details))
  check('another model does not', run.toWire(row({}), 'b/y').reasoning_details === undefined)
  check('nor does a row without any', run.toWire(row({ reasoningDetails: null }), 'a/x').reasoning_details === undefined)
  check('nor when nobody is asking', run.toWire(row({})).reasoning_details === undefined)
  check('an unreadable block list is left out rather than sent', run.toWire(row({ reasoningDetails: '{not json' }), 'a/x').reasoning_details === undefined)

  console.log('\n-- a cleared result goes to the model as a stub; the row keeps it --')
  const call = db.addMessage(conv.id, user.id, 'assistant', '', 'a/x', { toolCalls: '[{"id":"c1","type":"function","function":{"name":"read_file","arguments":"{}"}}]' })
  const res = db.addMessage(conv.id, call.id, 'tool', 'line one\n' + 'y'.repeat(2000), null, { toolCallId: 'c1' })
  check('a new row is not trimmed', db.listMessages(conv.id).find((m) => m.id === res.id).trimmed === false)
  db.markTrimmed([res.id])
  const marked = db.listMessages(conv.id).find((m) => m.id === res.id)
  check('marking sticks and the content stays', marked.trimmed === true && marked.content.length > 2000)
  const wire = run.toWire(marked, 'a/x')
  check('the wire gets the stub, with the call id', wire.role === 'tool' && wire.tool_call_id === 'c1' && /Cleared from the context/.test(wire.content) && /line one/.test(wire.content) && wire.content.length < 300, JSON.stringify(wire).slice(0, 200))
  check('the same row untrimmed goes whole', run.toWire({ ...marked, trimmed: false }, 'a/x').content.length > 2000)
  check('the version stamp moved with the column', db.SCHEMA_VERSION >= 4)

  console.log('\n-- two user messages in a row become one --')
  const joined = run.coalesceUsers([{ role: 'user', content: 'a' }, { role: 'user', content: 'b' }, { role: 'assistant', content: 'c' }, { role: 'user', content: 'd' }])
  check('adjacent text is joined', joined.length === 3 && joined[0].content === 'a\n\nb' && joined[2].content === 'd', JSON.stringify(joined))
  const mixed = run.coalesceUsers([{ role: 'user', content: 'summary' }, { role: 'user', content: [{ type: 'text', text: 'q' }, { type: 'image_url', image_url: { url: 'x' } }] }])
  check('text before parts becomes a text part ahead of them', mixed.length === 1 && Array.isArray(mixed[0].content) && mixed[0].content.length === 3 && mixed[0].content[0].text === 'summary', JSON.stringify(mixed))

  console.log('\n-- a stop is remembered until the turn ends --')
  OR.beginRequest('r-x')
  check('a fresh request is not cancelled', OR.isCancelled('r-x') === false && OR.signalFor('r-x').aborted === false)
  OR.cancel('r-x')
  check('after a stop the loop can still see it', OR.isCancelled('r-x') === true && OR.signalFor('r-x').aborted === true)
  OR.cancel('r-x')
  check('stopping twice is harmless', OR.isCancelled('r-x') === true)
  OR.endRequest('r-x')
  check('the request is forgotten only when the turn ends', OR.isCancelled('r-x') === false && OR.signalFor('r-x') === undefined)

  /*
    A turn stopped before the model answers ends with done, not error, and
    the blank placeholder it had inserted is marked so the model is not shown
    an empty turn of its own next time. Stopping right after runTurn is called
    lands after beginRequest and before the request goes out.
  */
  const stoppedId = 'r-stopped'
  const stopped = []
  const turn = run.runTurn(
    { requestId: stoppedId, conversationId: conv.id, parentId: user.id, model: 'some/model', agent: false, web: false, reasoning: false, params: {} },
    (e) => stopped.push(e),
    () => {}
  )
  OR.cancel(stoppedId)
  await turn
  check('a stopped turn ends with done, not error', stopped.some((e) => e.type === 'done') && !stopped.some((e) => e.type === 'error'), JSON.stringify(stopped.map((e) => e.type)))
  const placeholder = db.listMessages(conv.id).filter((m) => m.role === 'assistant').pop()
  check('the empty reply is marked as stopped, not left blank', !!placeholder && /Stopped before/.test(placeholder.error ?? ''), placeholder ? JSON.stringify({ content: placeholder.content, error: placeholder.error }) : 'no assistant row')
  check('and the request is forgotten', OR.isCancelled(stoppedId) === false)

  console.log(`\n${pass} passed, ${fail} failed`)
  app.exit(fail === 0 ? 0 : 1)
}).catch((e) => { console.log('THREW ' + e.stack); app.exit(1) })
