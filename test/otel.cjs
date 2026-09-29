const { app } = require('electron')
const fs = require('fs')
const http = require('http')
const path = require('path')

const TMP = '/tmp/harbor-otel-test'
fs.rmSync(TMP, { recursive: true, force: true })
fs.mkdirSync(TMP, { recursive: true })
app.setPath('userData', TMP)

app.whenReady().then(async () => {
  const { db, otel: O } = require('../out/test/entry.cjs')
  let pass = 0, fail = 0
  const check = (label, ok, detail = '') => {
    console.log((ok ? 'ok    ' : 'FAIL  ') + label + (ok || !detail ? '' : ' -- ' + detail))
    ok ? pass++ : fail++
  }
  db.initDb()

  console.log('-- off until an endpoint is set --')
  check('nothing is sent with no endpoint', !O.enabled())
  const idle = O.startSpan('chat', { a: 1 })
  idle.end()
  check('a span ended with no endpoint is dropped, not queued', O.pending() === 0 && (await O.flush()) === 0)
  check('headers are read one per line', JSON.stringify(O.parseHeaders('Authorization: Bearer x\n\nbad line\nX-Org : team:blue ')) === JSON.stringify({ Authorization: 'Bearer x', 'X-Org': 'team:blue' }) && Object.keys(O.parseHeaders(null)).length === 0)

  console.log('\n-- the shape on the wire --')
  const body = O.otlpBody([{ traceId: 't'.repeat(32), spanId: 's'.repeat(16), name: 'chat', kind: 'client', start: 1000, end: 1250, attrs: { 'gen_ai.usage.input_tokens': 12, 'harbor.cost_usd': 0.5, 'harbor.agent': true, 'gen_ai.request.model': 'm/x' }, error: 'boom' }, { traceId: 't'.repeat(32), spanId: 'p'.repeat(16), parentSpanId: 's'.repeat(16), name: 'execute_tool', kind: 'internal', start: 1, end: 2, attrs: {} }], '1.2.3')
  const spans = body.resourceSpans[0].scopeSpans[0].spans
  check('the resource names the service and version', body.resourceSpans[0].resource.attributes.some((a) => a.key === 'service.name' && a.value.stringValue === 'harbor') && body.resourceSpans[0].scopeSpans[0].scope.version === '1.2.3')
  check('times are nanoseconds as strings, kinds are numbers, parents are carried', spans[0].startTimeUnixNano === '1000000000' && spans[0].endTimeUnixNano === '1250000000' && spans[0].kind === 3 && spans[1].kind === 1 && spans[1].parentSpanId === 's'.repeat(16) && spans[0].parentSpanId === undefined)
  const attr = (k) => spans[0].attributes.find((a) => a.key === k).value
  check('attributes are typed the OTLP way', attr('gen_ai.usage.input_tokens').intValue === '12' && attr('harbor.cost_usd').doubleValue === 0.5 && attr('harbor.agent').boolValue === true && attr('gen_ai.request.model').stringValue === 'm/x')
  check('an error is a status with its message; otherwise ok', spans[0].status.code === 2 && spans[0].status.message === 'boom' && spans[1].status.code === 1)

  console.log('\n-- to a collector --')
  const got = []
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      got.push({ headers: req.headers, body: JSON.parse(raw) })
      res.writeHead(200).end('{}')
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${server.address().port}/v1/traces`
  db.setSetting('otel_endpoint', url)
  db.setSetting('otel_headers', 'Authorization: Bearer secret')
  check('on once set', O.enabled())
  const turn = O.startTurn('req-1', { 'gen_ai.request.model': 'm/x', 'gen_ai.conversation.id': 'c1' })
  const step = O.startSpan('chat', { 'gen_ai.request.model': 'm/x' }, O.turnSpan('req-1'), 'client')
  step.end({ 'gen_ai.usage.input_tokens': 100, 'gen_ai.usage.output_tokens': 20, 'harbor.cost_usd': 0.001, skipped: null, empty: '' })
  const tool = O.startSpan('execute_tool', { 'gen_ai.tool.name': 'read_file' }, O.turnSpan('req-1'))
  tool.end({ 'harbor.tool.bytes': 5 }, 'Error: nope')
  const worker = O.startTurn('req-2', { 'gen_ai.request.model': 'w/x' }, 'req-1')
  worker.end()
  turn.end({ 'harbor.cost_usd': 0.001 })
  turn.end({ 'harbor.cost_usd': 9 })
  check('a turn is remembered while open and forgotten when ended', O.turnSpan('req-1') === null && O.turnSpan('req-2') === null)
  check('four spans wait', O.pending() === 4)
  const sent = await O.flush()
  check('one post carries them, with the headers', sent === 4 && got.length === 1 && got[0].headers.authorization === 'Bearer secret' && got[0].headers['content-type'] === 'application/json')
  const sentSpans = got[0].body.resourceSpans[0].scopeSpans[0].spans
  const byName = Object.fromEntries(sentSpans.map((s) => [s.name + (s.attributes.some((a) => a.key === 'gen_ai.request.model' && a.value.stringValue === 'w/x') ? ':worker' : ''), s]))
  check('the step and the tool hang under the turn, in one trace', byName.chat.parentSpanId === byName.invoke_agent.spanId && byName.execute_tool.parentSpanId === byName.invoke_agent.spanId && byName.chat.traceId === byName.invoke_agent.traceId)
  check('a worker\'s turn hangs under its caller\'s', byName['invoke_agent:worker'].parentSpanId === byName.invoke_agent.spanId && byName['invoke_agent:worker'].traceId === byName.invoke_agent.traceId)
  check('the turn names the operation, and ending twice counts once', byName.invoke_agent.attributes.some((a) => a.key === 'gen_ai.operation.name' && a.value.stringValue === 'invoke_agent') && byName.invoke_agent.attributes.find((a) => a.key === 'harbor.cost_usd').value.doubleValue === 0.001)
  check('the tool\'s failure is its status; null and empty attributes are left out', byName.execute_tool.status.code === 2 && byName.execute_tool.status.message === 'Error: nope' && !byName.chat.attributes.some((a) => a.key === 'skipped' || a.key === 'empty'))
  check('the queue is empty after', O.pending() === 0)

  server.close()
  const down = O.startSpan('chat', {})
  down.end()
  check('a collector that is down loses the batch, not the turn', (await O.flush()) === 0 && O.pending() === 0)
  db.setSetting('otel_endpoint', '')
  check('cleared, it is off again', !O.enabled())

  console.log(`\n${pass} passed, ${fail} failed`)
  app.exit(fail ? 1 : 0)
}).catch((e) => { console.log('THREW ' + e.stack); app.exit(1) })
