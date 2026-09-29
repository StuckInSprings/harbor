const { app } = require('electron')
const fs = require('fs')
const http = require('http')

const TMP = '/tmp/harbor-local-test'
fs.rmSync(TMP, { recursive: true, force: true })
fs.mkdirSync(TMP, { recursive: true })
app.setPath('userData', TMP)

app.whenReady().then(async () => {
  const { db, openrouter: OR } = require('../out/test/entry.cjs')
  let pass = 0, fail = 0
  const check = (label, ok, detail = '') => {
    console.log((ok ? 'ok    ' : 'FAIL  ') + label + (ok || !detail ? '' : ' -- ' + detail))
    ok ? pass++ : fail++
  }
  db.initDb()

  // A fake server in the OpenAI dialect: lists one model, streams a reply, answers a plain call.
  const seen = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (d) => (body += d))
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization ?? null, body: body ? JSON.parse(body) : null })
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ data: [{ id: 'tiny-llama' }, { id: 'coder-7b' }] }))
        return
      }
      if (req.url === '/v1/chat/completions') {
        const parsed = JSON.parse(body)
        if (parsed.stream) {
          res.writeHead(200, { 'content-type': 'text/event-stream' })
          const chunk = (delta, extra = {}) => `data: ${JSON.stringify({ id: 'x', model: parsed.model, choices: [{ delta, finish_reason: null }], ...extra })}\n\n`
          res.write(chunk({ content: 'hello ' }))
          setTimeout(() => {
            res.write(chunk({ content: 'world' }))
            res.write(`data: ${JSON.stringify({ id: 'x', model: parsed.model, choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 7, completion_tokens: 2 } })}\n\n`)
            res.write('data: [DONE]\n\n')
            res.end()
          }, 30)
        } else {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ choices: [{ message: { content: 'plain reply' } }], usage: { prompt_tokens: 3, completion_tokens: 2 } }))
        }
        return
      }
      res.writeHead(404)
      res.end()
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}/v1`

  console.log('-- the catalogue --')
  check('with no key and no endpoint, models cannot be listed', await OR.fetchModels().then(() => false, (e) => /No OpenRouter key/.test(e.message)))
  db.setSetting('local_base_url', base + '/')
  db.setSetting('local_api_key', 'sk-local')
  const models = await OR.fetchModels()
  check('with an endpoint and no key, the local models are the catalogue, prefixed and free', models.map((m) => m.id).join(',') === 'local/tiny-llama,local/coder-7b' && models[0].promptPrice === 0 && models[0].contextLength === 32768 && models[0].supportsTools, models.map((m) => m.id).join(','))
  check('the key went along, and the trailing slash did not', seen[0].auth === 'Bearer sk-local' && seen[0].url === '/v1/models')
  db.setSetting('local_context_length', '8192')
  check('the window is the setting', (await OR.contextLengthOf('local/tiny-llama')) === 8192 && (await OR.fetchModels())[0].contextLength === 8192)

  console.log('\n-- a streamed turn against it --')
  OR.beginRequest('r-local')
  let streamed = ''
  const result = await OR.streamCompletion('r-local', { model: 'local/tiny-llama', messages: [{ role: 'user', content: 'hi' }], tools: [{ type: 'function', function: { name: 'read_file', parameters: {} } }, { type: 'openrouter:web_search' }], plugins: [{ id: 'web' }], reasoning: true, routing: { models: ['x'] }, sessionId: 'c1' }, (t) => (streamed += t), () => {}, () => {})
  OR.endRequest('r-local')
  const sent = seen.find((s) => s.url === '/v1/chat/completions' && s.body.stream)
  check('the reply streams and the usage on the last chunk is read', streamed === 'hello world' && result.content === 'hello world' && result.usage.promptTokens === 7 && result.finishReason === 'stop', JSON.stringify(result).slice(0, 200))
  check('the server saw the bare model id, the function tools only, and usage asked for in the dialect', sent.body.model === 'tiny-llama' && sent.body.tools.length === 1 && sent.body.stream_options.include_usage === true, JSON.stringify(sent.body).slice(0, 300))
  check("none of OpenRouter's fields went along", !('plugins' in sent.body) && !('provider' in sent.body) && !('models' in sent.body) && !('reasoning' in sent.body))
  const plain = await OR.complete('local/coder-7b', [{ role: 'user', content: 'x' }])
  check('a plain call works too', plain === 'plain reply')
  const once = await OR.chatOnce('local/coder-7b', [{ role: 'user', content: 'x' }], { maxTokens: 10 })
  check('and a priced one, at no cost', once.content === 'plain reply' && once.cost === 0 && once.promptTokens === 3)

  console.log('\n-- when it is not there --')
  db.setSetting('local_base_url', '')
  check('a local model with no endpoint set says what to do', await OR.complete('local/x', []).then(() => false, (e) => /Add its URL in Settings/.test(e.message)))
  db.setSetting('local_base_url', 'http://127.0.0.1:1/v1')
  check('an endpoint that does not answer lists nothing rather than failing the catalogue', (await OR.fetchLocalModels()).length === 0)
  server.close()

  console.log(`\n${pass} passed, ${fail} failed`)
  app.exit(fail === 0 ? 0 : 1)
}).catch((e) => { console.log('THREW ' + e.stack); app.exit(1) })
