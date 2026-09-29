const { app } = require('electron')
const fs = require('fs')
const http = require('http')
const path = require('path')
const { execFileSync } = require('child_process')

const TMP = '/tmp/harbor-bridge-test'
fs.rmSync(TMP, { recursive: true, force: true })
fs.mkdirSync(TMP, { recursive: true })
app.setPath('userData', path.join(TMP, 'data'))

app.whenReady().then(async () => {
  const { db, run, bridge: B, bridgeShared: S, director: D } = require('../out/test/entry.cjs')
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js')
  const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js')
  let pass = 0, fail = 0
  const check = (label, ok, detail = '') => {
    console.log((ok ? 'ok    ' : 'FAIL  ') + label + (ok || !detail ? '' : ' -- ' + detail))
    ok ? pass++ : fail++
  }
  const throws = (fn, re) => { try { fn(); return false } catch (e) { return re.test(e.message) } }

  console.log('-- the rules --')
  check('a budget is required, positive, and within the cap', throws(() => S.checkBudget(0, 5), /more than 0/) && throws(() => S.checkBudget(undefined, 5), /more than 0/) && throws(() => S.checkBudget(6, 5), /over the \$5\.00/) && S.checkBudget(2.345, 5) === 2.35 && S.checkBudget('3', 5) === 3)
  check('only the loopback names on the right port are let in', S.allowedHost('127.0.0.1:4000', 4000) && S.allowedHost('localhost:4000', 4000) && !S.allowedHost('evil.test:4000', 4000) && !S.allowedHost('127.0.0.1:4001', 4000) && !S.allowedHost(undefined, 4000))
  check('a browser, which always sends Origin, is not', S.allowedOrigin(undefined) && !S.allowedOrigin('https://evil.test') && !S.allowedOrigin('null'))
  check('the bearer token is read from its header', S.bearerOf('Bearer abc') === 'abc' && S.bearerOf('bearer  xyz ') === 'xyz' && S.bearerOf('Basic abc') === null && S.bearerOf(undefined) === null)
  check('the port and cap fall back when unset or nonsense', S.parsePort('80') === S.DEFAULT_PORT && S.parsePort('5000') === 5000 && S.parseCap('') === S.DEFAULT_CAP && S.parseCap('-1') === S.DEFAULT_CAP && S.parseCap('12.5') === 12.5)
  check('the command registers Harbor for every folder, token in its header', S.claudeAddCommand(5000, 'tok') === 'claude mcp add --scope user --transport http harbor http://127.0.0.1:5000/mcp --header "Authorization: Bearer tok"')
  const items = [{ id: 'aaaaaaaa-1', name: 'Docs' }, { id: 'aaaaaaaa-2', name: 'Parser' }, { id: 'bbbbbbbb-1', name: 'docs' }]
  check('a thing is found by id, name, or a long enough id prefix', S.resolveOne(items, 'aaaaaaaa-2', 'p').name === 'Parser' && S.resolveOne(items, 'parser', 'p').id === 'aaaaaaaa-2' && S.resolveOne(items, 'bbbbbbbb', 'p').name === 'docs')
  check('and an ambiguous or missing name says so', throws(() => S.resolveOne(items, 'docs', 'project'), /More than one project/) && throws(() => S.resolveOne(items, 'aaaaaaaa', 'p'), /More than one/) && throws(() => S.resolveOne(items, 'nope', 'project'), /No project matches/) && throws(() => S.resolveOne(items, '', 'project'), /Say which project/))
  const t = S.transcriptText([
    { role: 'user', content: 'one', error: null, toolCalls: null, createdAt: 0 },
    { role: 'assistant', content: '', error: null, toolCalls: JSON.stringify([{ function: { name: 'write_file' } }]), createdAt: 0 },
    { role: 'assistant', content: 'x'.repeat(S.MESSAGE_CUT + 10), error: null, toolCalls: null, createdAt: 0 },
    { role: 'assistant', content: '', error: 'boom', toolCalls: null, createdAt: 0 }
  ], 3)
  check('a transcript names tool calls and failures, cuts long text, and says what it left out', t.startsWith('(1 earlier messages not shown)') && t.includes('called write_file') && t.includes('(10 more characters)') && t.includes('FAILED') && t.includes('Error: boom') && !t.includes('## user'), t.slice(0, 300))
  check('every tool has a schema and a read-only mark', S.TOOLS.length === 16 && S.TOOLS.every((x) => x.inputSchema.type === 'object' && typeof x.readOnly === 'boolean') && S.TOOLS.filter((x) => x.readOnly).map((x) => x.name).sort().join(',') === 'list_projects,list_runs,read_conversation,read_file,read_run_file,run_changes,run_status,wait')
  check('no tool writes a file, and the director takes no requirements of Claude\'s', !S.TOOLS.some((x) => /write|edit|create_file/.test(x.name)) && !('requirements' in S.TOOLS.find((x) => x.name === 'start_director').inputSchema.properties) && S.TOOLS.find((x) => x.name === 'start_director').inputSchema.required.includes('from_interview'))
  check('a note is marked as Claude\'s, and one long enough to be the work is refused', S.overseerNote(' continue ', S.NUDGE_MAX).startsWith(S.OVERSEER_FRAME) && S.overseerNote('continue', S.NUDGE_MAX).endsWith('\n\ncontinue') && throws(() => S.overseerNote('x'.repeat(S.ANSWER_MAX + 1), S.ANSWER_MAX, 'answer'), /an answer is at most 4000/) && throws(() => S.overseerNote('  ', S.NUDGE_MAX), /empty/))
  check('a nudge to a director is short, and judgement is pointed at the person', throws(() => S.overseerNote('x'.repeat(S.NUDGE_MAX + 1), S.NUDGE_MAX), /post_review/))
  check('the instructions say whose the writing and the answers are', /not their author/.test(S.INSTRUCTIONS) && /Never write the content yourself/.test(S.INSTRUCTIONS) && /person answers the interview in Harbor/.test(S.INSTRUCTIONS) && /post_review/.test(S.INSTRUCTIONS))
  const rv = S.parseReview({ verdict: ' Needs Work ', summary: 'T1 misses the units.', suggestions: ['one', { text: 'two', task: 'T2' }] })
  check('a review has a known verdict, a summary, and suggestions that start open', rv.verdict === 'needs work' && rv.suggestions.length === 2 && rv.suggestions[0].task === null && rv.suggestions[1].task === 'T2' && rv.suggestions.every((x) => x.state === 'open'))
  check('and nothing long enough to be the work', throws(() => S.parseReview({ verdict: 'great', summary: 'x' }), /verdict is one of/) && throws(() => S.parseReview({ verdict: 'on track', summary: '' }), /needs a summary/) && throws(() => S.parseReview({ verdict: 'on track', summary: 'x', suggestions: ['y'.repeat(S.SUGGESTION_MAX + 1)] }), /not the changed text/) && throws(() => S.parseReview({ verdict: 'on track', summary: 'x', suggestions: Array(S.SUGGESTIONS_MAX + 1).fill('z') }), /At most 10/))

  db.initDb()

  // A model server in the OpenAI dialect: one model, and a reply that takes a moment, so a wait sees the turn running.
  const asked = []
  const models = http.createServer((req, res) => {
    let body = ''
    req.on('data', (d) => (body += d))
    req.on('end', () => {
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ data: [{ id: 'tiny' }] }))
      }
      const parsed = JSON.parse(body)
      asked.push(parsed)
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const chunk = (delta, finish = null, extra = {}) => `data: ${JSON.stringify({ id: 'x', model: parsed.model, choices: [{ delta, finish_reason: finish }], ...extra })}\n\n`
      res.write(chunk({ content: 'The plan is ' }))
      setTimeout(() => {
        res.write(chunk({ content: 'written.' }))
        res.write(chunk({}, 'stop', { usage: { prompt_tokens: 7, completion_tokens: 2 } }))
        res.end('data: [DONE]\n\n')
      }, 1500)
    })
  })
  await new Promise((r) => models.listen(0, '127.0.0.1', r))
  db.setSetting('local_base_url', `http://127.0.0.1:${models.address().port}/v1`)
  db.setSetting('last_model', 'local/tiny')

  // A project under git, one without a repository, one without a folder, and one put away.
  const repo = path.join(TMP, 'repo')
  fs.mkdirSync(repo)
  fs.writeFileSync(path.join(repo, 'README.md'), 'hi\n')
  const git = (...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: repo, stdio: 'ignore' })
  git('init', '-q', '-b', 'main'); git('add', '.'); git('commit', '-q', '-m', 'start')
  const plain = path.join(TMP, 'plain')
  fs.mkdirSync(plain)
  const P = db.createProject('Tides', repo)
  const Plain = db.createProject('Loose', plain)
  db.createProject('Nowhere', null)
  const Old = db.createProject('Old', plain)
  db.setProjectArchived(Old.id, true)
  const chat = db.createConversation(P.id, 'local/tiny')

  const events = []
  const notices = []
  const notified = []
  let changes = 0
  B.configure({
    launch: (requestId, opts, notify) => { if (notify) notified.push(opts.conversationId); void run.runTurn({ ...opts, requestId }, (e) => events.push(e), () => {}) },
    cancel: () => {},
    changed: () => { changes++ },
    notice: (n) => notices.push(n)
  })

  console.log('\n-- the server --')
  await B.init()
  check('it is off until turned on', B.status().enabled === false && B.status().running === false)
  const port = 47000 + (process.pid % 1000)
  db.setSetting(S.ENABLED_SETTING, '1')
  db.setSetting(S.PORT_SETTING, String(port))
  await B.init()
  const st = B.status()
  check('turned on, it listens on the loopback address', st.running && st.url === `http://127.0.0.1:${port}/mcp` && st.error === null, JSON.stringify(st))
  const tokenOf = (s) => /Bearer ([^"]+)"/.exec(s.command)[1]
  const token = tokenOf(st)
  check('the token is stored and stays the same', token.length >= 24 && tokenOf(B.status()) === token && !!db.getSetting(S.TOKEN_SETTING) && !db.getSetting(S.TOKEN_SETTING).includes(token))

  const raw = (headers, method = 'POST') => new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/mcp', method, headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers } }, (res) => { res.resume(); resolve(res.statusCode) })
    req.on('error', () => resolve('closed'))
    req.end(method === 'POST' ? JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) : undefined)
  })
  check('no token, no entry', (await raw({})) === 401 && (await raw({ authorization: 'Bearer wrong' })) === 401)
  check('a page in a browser is refused even with the token', (await raw({ authorization: `Bearer ${token}`, origin: 'https://evil.test' })) === 403)
  check('so is a name that is not this machine', (await raw({ authorization: `Bearer ${token}`, host: `evil.test:${port}` })) === 403)
  check('stateless: only POST', (await raw({ authorization: `Bearer ${token}` }, 'GET')) === 405)

  const connect = async (tok) => {
    const client = new Client({ name: 'test', version: '1' })
    await client.connect(new StreamableHTTPClientTransport(new URL(st.url), { requestInit: { headers: { Authorization: `Bearer ${tok}` } } }))
    return client
  }
  const client = await connect(token)
  const callRaw = (name, args = {}) => client.callTool({ name, arguments: args })
  const call = async (name, args = {}) => {
    const r = await callRaw(name, args)
    const text = r.content[0].text
    if (r.isError) throw new Error(text)
    try { return JSON.parse(text) } catch { return text }
  }
  const refused = async (name, args, re) => { const r = await callRaw(name, args); return r.isError === true && re.test(r.content[0].text) ? true : r.content[0].text }
  check('the real SDK client connects and lists the tools', (await client.listTools()).tools.map((x) => x.name).join(',') === S.TOOLS.map((x) => x.name).join(','))
  check('it is told how a run goes', /approve_plan/.test(client.getInstructions() ?? ''))

  console.log('\n-- looking --')
  const listed = await call('list_projects')
  check('projects with a folder, archived ones left out', listed.map((p) => p.name).sort().join(',') === 'Loose,Tides', JSON.stringify(listed))
  check('a chat cannot be named: the bridge is for runs', await refused('read_conversation', { conversation: chat.id }, /No interview or director or worker matches/))

  console.log('\n-- the interview --')
  const reqs = '## Outcome\nA tide table for the harbour.\n\n## Done means\nOne CSV file.'
  check('a director will not start without an interview: the requirements are Harbor\'s', await refused('start_director', { project: 'Tides', budget: 1 }, /start_interview first/))
  check('the person answers for themselves unless they say otherwise', B.status().answers === false)
  const iv = await call('start_interview', { project: 'Tides', message: 'The person wants a tide table for the harbour.' })
  const ivConv = db.getConversation(iv.interview)
  check('an interview begins its own run folder', ivConv.role === 'interview' && ivConv.title === 'Interview (Claude)' && ivConv.runDir === iv.runFolder && changes > 0)
  check('and Claude is told the person answers it, in Harbor', iv.answeredBy === 'the person, in Harbor' && /waiting for them in Harbor/.test(iv.next))
  check('the person is told it is waiting on them, and when its questions are ready', notices.some((n) => n.kind === 'interview' && n.conversationId === ivConv.id && /needs your answers/.test(n.text)) && notified.includes(ivConv.id))
  const brief = db.listMessages(ivConv.id).find((m) => m.role === 'user')
  check('the brief reaches the interviewer marked as Claude\'s', brief.content.startsWith(S.OVERSEER_FRAME) && brief.content.endsWith('The person wants a tide table for the harbour.'))
  const early = await call('wait', { conversation: ivConv.id, seconds: 1 })
  check('a short wait comes back saying it is still going', early.reason === 'still running' && early.running === true, JSON.stringify(early).slice(0, 200))
  const ivIdle = await call('wait', { conversation: ivConv.id.slice(0, 8), seconds: 4 })
  check('once the interviewer has asked, the wait is on the person, not on the turn', ivIdle.reason === 'waiting on the person' && ivIdle.running === false && ivIdle.latestReply === 'The plan is written.' && ivIdle.answeredBy === 'the person, in Harbor', JSON.stringify(ivIdle).slice(0, 300))
  const turnAsk = asked.find((a) => a.stream)
  check('the turn ran on the model, as an agent, with its tools', !!turnAsk && turnAsk.model === 'tiny' && Array.isArray(turnAsk.tools) && turnAsk.tools.some((x) => x.function.name === 'write_file'), JSON.stringify(asked.map((a) => ({ model: a.model, tools: (a.tools ?? []).length, stream: a.stream }))))
  check('the window heard it as any turn', events.some((e) => e.type === 'done'))
  check('Claude cannot answer the interview for the person', await refused('send_message', { conversation: ivConv.id, text: 'The table covers March.' }, /person answers this interview in Harbor/))
  check('a director will not plan from an interview with no requirements', await refused('start_director', { project: 'Tides', budget: 1, from_interview: iv.interview }, /person is answering it in Harbor/))
  // The person answers in Harbor and the interviewer writes the requirements; the model here is a fake, so the test writes them.
  const waiting = call('wait', { conversation: ivConv.id, seconds: 30 })
  await new Promise((r) => setTimeout(r, 1200))
  fs.mkdirSync(path.join(repo, ivConv.runDir), { recursive: true })
  fs.writeFileSync(path.join(repo, D.runFiles(ivConv.runDir).requirements), reqs)
  const written = await waiting
  check('the wait returns when the requirements are written', written.reason === 'requirements written' && written.requirementsWritten === true, JSON.stringify(written).slice(0, 200))

  console.log('\n-- when the person lets Claude answer --')
  db.setSetting(S.ANSWERS_SETTING, '1')
  const before = notices.length
  const iv2 = await call('start_interview', { project: 'Tides', message: 'Another table.' })
  check('Claude is told it answers, and the person is not called', iv2.answeredBy === 'you, for the person' && notices.length === before)
  await call('wait', { conversation: iv2.interview, seconds: 30 })
  check('the status says so', B.status().answers === true && (await call('run_status', { conversation: iv2.interview })).answeredBy === 'you, for the person')
  check('an answer long enough to be the work is refused', await refused('send_message', { conversation: iv2.interview, text: 'y'.repeat(S.ANSWER_MAX + 1) }, /an answer is at most 4000/))
  await call('send_message', { conversation: iv2.interview, text: 'The person has not chosen a name; that is open.' })
  const relayed = db.listMessages(iv2.interview).filter((m) => m.role === 'user').pop()
  check('Claude relays the answer, marked as its own', relayed.content.startsWith(S.OVERSEER_FRAME) && relayed.content.endsWith('that is open.'))
  const idle2 = await call('wait', { conversation: iv2.interview, seconds: 30 })
  check('and its wait is on the turn again', idle2.reason === 'idle')
  db.setSetting(S.ANSWERS_SETTING, '0')

  console.log('\n-- the director --')
  check('no budget, no run', await refused('start_director', { project: 'Tides', from_interview: iv.interview }, /more than 0/))
  check('nor one over the cap', await refused('start_director', { project: 'Tides', from_interview: iv.interview, budget: 50 }, /over the \$5\.00/))
  check('nor from another project\'s interview', await refused('start_director', { project: 'Loose', budget: 1, from_interview: iv.interview }, /another project/))
  check('and a model that exists', await refused('start_director', { project: 'Tides', budget: 1, from_interview: iv.interview, model: 'nope/nothing' }, /no nope\/nothing/))
  const plainIv = await call('start_interview', { project: 'Loose', message: 'Anything.' })
  await call('wait', { conversation: plainIv.interview, seconds: 3 })
  const plainDir = db.getConversation(plainIv.interview).runDir
  fs.mkdirSync(path.join(plain, plainDir), { recursive: true })
  fs.writeFileSync(path.join(plain, D.runFiles(plainDir).requirements), reqs)
  check('and a folder under git', await refused('start_director', { project: 'Loose', budget: 1, from_interview: plainIv.interview }, /under git/))
  const started = await call('start_director', { project: 'Tides', budget: 2, from_interview: iv.interview, requirements: 'ignored: not Claude\'s to write' })
  const dir = db.getConversation(started.director)
  check('a director starts in the interview\'s folder, with the budget asked for', !!dir && dir.role === 'director' && dir.budget === 2 && dir.runDir === ivConv.runDir && started.runFolder === ivConv.runDir, JSON.stringify(started))
  check('it says where it came from', dir.title === 'Director (Claude)')
  check('the requirements are still the interviewer\'s', fs.readFileSync(path.join(repo, D.runFiles(dir.runDir).requirements), 'utf8') === reqs)
  const opening = db.listMessages(dir.id).find((m) => m.role === 'user')
  check('its first turn is the opening the window sends, not a note', opening?.content === D.DIRECTOR_OPENING)
  await call('wait', { conversation: dir.id, seconds: 30 })

  console.log('\n-- the plan --')
  check('there is no plan to approve until one is written', await refused('approve_plan', { director: dir.id }, /no plan to approve/))
  const F = D.runFiles(dir.runDir)
  fs.writeFileSync(path.join(repo, F.design), '# Design\nOne table.\n')
  fs.writeFileSync(path.join(repo, F.tasks), '# Board\n\n- [ ] T1 — Write the table\n')
  const status = await call('run_status', { conversation: dir.id })
  check('the status has the board, the money and the files', status.board.length === 1 && status.board[0].id === 'T1' && status.budget === 2 && status.left <= 2 && status.approved === false && status.files.design === F.design && Array.isArray(status.questions), JSON.stringify(status).slice(0, 300))
  check('a run file is read by name', (await call('read_run_file', { conversation: dir.id, file: 'design' })).includes('One table.') && /has not been written yet/.test(await call('read_run_file', { conversation: dir.id, file: 'handoff' })) && (await call('read_run_file', { conversation: dir.id, file: 'guidance' })).includes(D.GUIDANCE_FILE))
  check('only a run file', await refused('read_run_file', { conversation: dir.id, file: '../../etc/passwd' }, /file is one of/))
  const approved = await call('approve_plan', { director: dir.id })
  check('the overseer approves, and the director is told to begin', approved.approved === true && db.getConversation(dir.id).approved === true && db.listMessages(dir.id).some((m) => m.role === 'user' && m.content === D.APPROVAL_MESSAGE))
  await call('wait', { conversation: dir.id, seconds: 30 })
  check('once is enough', await refused('approve_plan', { director: dir.id }, /already approved/))

  console.log('\n-- reviewing the work --')
  fs.mkdirSync(path.join(repo, 'data'))
  fs.writeFileSync(path.join(repo, 'data', 'tides.md'), '# Tides\nHigh water at six.\n')
  fs.writeFileSync(path.join(repo, 'README.md'), 'hi, changed\n')
  const changed = await call('run_changes', { director: dir.id })
  const byPath = Object.fromEntries(changed.changes.map((c) => [c.path, c.status]))
  check('the run\'s changes since its first commit, committed or not', changed.base === dir.runBase && byPath['data/tides.md'] === 'added' && byPath['README.md'] === 'modified' && byPath[F.design] === 'added', JSON.stringify(changed))
  check('a file of the work is read to review it', (await call('read_file', { conversation: dir.id, path: 'data/tides.md' })).includes('High water at six.'))
  check('but nothing outside the folder', await refused('read_file', { conversation: dir.id, path: '../plain/x' }, /outside|escape|not inside|project/i))
  check('a long critique is not a nudge: it goes to the person', await refused('send_message', { conversation: dir.id, text: 'The parser is wrong because '.repeat(40) }, /post_review/))
  await call('send_message', { conversation: dir.id, text: 'continue' })
  const note = db.listMessages(dir.id).filter((m) => m.role === 'user').pop()
  check('a nudge reaches the director marked as Claude\'s', note.content.startsWith(S.OVERSEER_FRAME) && note.content.endsWith('continue'))
  await call('wait', { conversation: dir.id, seconds: 30 })

  console.log('\n-- the review --')
  check('a review needs a known verdict', await refused('post_review', { director: dir.id, verdict: 'splendid', summary: 'x' }, /verdict is one of/))
  const posted = await call('post_review', { director: dir.id, verdict: 'needs work', summary: 'T1 misses **Done means**: no units section.', suggestions: [{ text: 'Ask for a units section in the parser, as Done means requires.', task: 'T1' }, 'Check the README change was meant.'] })
  const reviews = db.listReviews(dir.id)
  check('it is kept for the person, suggestions open', reviews.length === 1 && reviews[0].id === posted.posted && reviews[0].verdict === 'needs work' && reviews[0].suggestions.length === 2 && reviews[0].suggestions[0].task === 'T1' && reviews[0].suggestions.every((x) => x.state === 'open'))
  check('the person is told', notices.some((n) => n.kind === 'review' && n.conversationId === dir.id && /needs work, 2 suggestions/.test(n.text)))
  check('nothing of it reaches the director on its own', !db.listMessages(dir.id).some((m) => m.content.includes('units section')))
  db.setSuggestionState(reviews[0].id, 0, 'sent')
  db.setSuggestionState(reviews[0].id, 1, 'dismissed')
  const seen = await call('run_status', { conversation: dir.id })
  check('and Claude sees what the person did with each suggestion', seen.reviews.length === 1 && seen.reviews[0].suggestions[0].state === 'sent' && seen.reviews[0].suggestions[1].state === 'dismissed')
  const transcript = await call('read_conversation', { conversation: dir.id })
  check('the transcript has both sides', transcript.includes('## user') && transcript.includes(D.APPROVAL_MESSAGE) && transcript.includes('The plan is written.'))
  check('no worker is waiting on anything', await refused('answer_question', { worker: 'nobody-at-all', answer: 'x' }, /No worker matches/))
  const worker = db.createConversation(P.id, 'local/tiny', false, 'worker', { runId: dir.id, title: 'T1 — Write the table' })
  check('a worker\'s question is the person\'s to answer', await refused('answer_question', { worker: worker.id, answer: 'March' }, /has not let you answer/))
  db.setSetting(S.ANSWERS_SETTING, '1')
  check('unless they let Claude answer, and then only a question actually asked', await refused('answer_question', { worker: worker.id, answer: 'March' }, /not waiting on a question/))
  db.setSetting(S.ANSWERS_SETTING, '0')
  const runsListed = await call('list_runs', { project: P.id })
  check('the run is listed with its interviews', runsListed.length === 3 && runsListed.some((r) => r.id === dir.id && r.approved === true && r.running === false) && runsListed.some((r) => r.id === iv.interview))

  console.log('\n-- finishing --')
  const fin = await call('finish_run', { director: dir.id })
  check('finishing writes the run log in the run folder', fin.log === D.runFiles(dir.runDir).log && fs.existsSync(path.join(repo, fin.log)))
  check('and the log is then a run file', (await call('read_run_file', { conversation: dir.id, file: 'log' })).includes('# '))

  console.log('\n-- the token --')
  const fresh = tokenOf({ command: (await (async () => { B.newToken(); return B.status() })()).command })
  check('a new token replaces the old at once', fresh !== token && (await raw({ authorization: `Bearer ${token}` })) === 401 && (await raw({ authorization: `Bearer ${fresh}` })) === 200)
  await client.close().catch(() => {})
  db.setSetting(S.ENABLED_SETTING, '0')
  await B.init()
  check('turned off, it stops listening', B.status().running === false && (await raw({ authorization: `Bearer ${fresh}` }).catch(() => 'closed')) !== 200)

  models.close()
  console.log(`\n${pass} passed, ${fail} failed`)
  app.exit(fail ? 1 : 0)
})
