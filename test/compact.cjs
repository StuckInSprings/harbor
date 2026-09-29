const { app } = require('electron')
const fs = require('fs')

const TMP = '/tmp/harbor-compact-test'
fs.rmSync(TMP, { recursive: true, force: true })
fs.mkdirSync(TMP, { recursive: true })
app.setPath('userData', TMP)

app.whenReady().then(async () => {
  const { db, compact: C, compaction } = require('../out/test/entry.cjs')
  let pass = 0, fail = 0
  const check = (label, ok, detail = '') => {
    console.log((ok ? 'ok    ' : 'FAIL  ') + label + (ok || !detail ? '' : ' -- ' + detail))
    ok ? pass++ : fail++
  }
  const msg = (role, content, extra = {}) => ({
    id: Math.random().toString(36).slice(2), conversationId: 'c', parentId: null, role, content,
    model: null, reasoning: null, error: null, toolCalls: null, toolCallId: null, summaryOf: null,
    citations: null, attachments: null, promptTokens: null, completionTokens: null,
    cachedTokens: null, cacheWriteTokens: null, prefixHash: null, reasoningTokens: null, cost: null, createdAt: 0, ...extra
  })
  const words = (n) => 'word '.repeat(n).trim()

  console.log('-- when it is time --')
  check('a small prompt is left alone', C.shouldCompact(1000, 100000, 4000) === false)
  check('a prompt at the line is compacted', C.shouldCompact(79000, 100000, 4000) === true)
  check('the reply reserve counts', C.shouldCompact(77000, 100000, 4000) === true &&
    C.shouldCompact(77000, 100000, 1000) === false)
  check('an unknown window never compacts', C.shouldCompact(1e9, 0, 0) === false)

  console.log('\n-- where to cut --')
  check('too short to bother', C.chooseCut([msg('user', 'a'), msg('assistant', 'b'), msg('user', 'c')], 10) === null)
  const path = [
    msg('user', words(100)), msg('assistant', words(100)),
    msg('user', words(100)), msg('assistant', words(100)),
    msg('user', words(100)), msg('assistant', words(100)),
    msg('user', words(20))
  ]
  const cut = C.chooseCut(path, 300)
  check('the kept tail starts at a user message', cut && cut.keep[0].role === 'user',
    cut && cut.keep.map((m) => m.role).join(' '))
  check('and is the most recent whole exchanges that fit',
    cut && cut.keep.length === 3 && cut.summarise.length === 4,
    cut && `${cut.summarise.length} / ${cut.keep.length}`)
  const partial = C.chooseCut(path, 200)
  check('a reply that fits without its question is dropped, not kept headless',
    partial && partial.keep.length === 1 && partial.keep[0].role === 'user',
    partial && partial.keep.map((m) => m.role).join(' '))
  const tiny = C.chooseCut(path, 1)
  check('a budget too small still keeps the latest question',
    tiny && tiny.keep.length === 1 && tiny.keep[0].role === 'user')
  const toolPath = [
    msg('user', words(100)), msg('assistant', words(100)),
    msg('user', words(100)),
    msg('assistant', '', { toolCalls: '[{"id":"t1","function":{"name":"read_file","arguments":"{\\"path\\":\\"a\\"}"}}]' }),
    msg('tool', words(400), { toolCallId: 't1' }),
    msg('assistant', words(30)),
    msg('user', words(10))
  ]
  const tc = C.chooseCut(toolPath, 60)
  check('a tool result is never kept without its call',
    tc && !(tc.keep[0].role === 'tool') && !(tc.keep[0].role === 'assistant'),
    tc && tc.keep.map((m) => m.role).join(' '))

  console.log('\n-- an image is a picture, not its bytes --')
  const png = 'A'.repeat(400_000)
  const withImage = [{ role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,' + png } }] }, { role: 'assistant', content: 'seen' }]
  const est = C.estimateWireTokens(withImage)
  check('a 400KB image on the wire counts as a flat picture, not 100K tokens', est > C.IMAGE_TOKENS && est < C.IMAGE_TOKENS + 100, String(est))
  check('a pdf part likewise', C.estimateWireTokens([{ role: 'user', content: [{ type: 'file', file: { filename: 'x.pdf', file_data: 'data:application/pdf;base64,' + png } }] }]) < C.PDF_TOKENS + 100)
  check('text and tool calls still count by length', C.estimateWireTokens([{ role: 'assistant', content: 'x'.repeat(400), tool_calls: [{ id: '1', function: { name: 'read_file', arguments: '{"path":"a"}' } }] }]) > 100)
  const stored = msg('user', 'see this', { attachments: JSON.stringify([{ kind: 'image', size: 300000 }, { kind: 'text', size: 400 }]) })
  check('a stored message counts its attachments by kind', C.messageTokens(stored) > C.IMAGE_TOKENS + 100 && C.messageTokens(stored) < C.IMAGE_TOKENS + 200, String(C.messageTokens(stored)))
  check('and its tool calls', C.messageTokens(msg('assistant', '', { toolCalls: 'x'.repeat(4000) })) >= 1000)
  const heavy = [msg('user', 'a'), msg('assistant', 'b'), msg('user', 'c', { attachments: JSON.stringify([{ kind: 'image', size: 1 }]) }), msg('assistant', 'd'), msg('user', 'e'), msg('assistant', 'f'), msg('user', 'g')]
  const heavyCut = C.chooseCut(heavy, 1000)
  check('the cut sees an attachment as weight', heavyCut && heavyCut.keep[0].content === 'e', heavyCut ? heavyCut.keep[0].content : 'null')

  console.log('\n-- what is cleared before anything is summarised --')
  const big = 'x'.repeat(900)
  const tool = (i, extra = {}) => msg('tool', big, { toolCallId: 't' + i, ...extra })
  const trimPath = [msg('user', 'go')]
  for (let i = 0; i < 9; i++) { trimPath.push(msg('assistant', '', { toolCalls: '[]' })); trimPath.push(tool(i)) }
  const t1 = C.chooseTrim(trimPath)
  check('the newest six results are kept, the older three go', t1.results.length === 3 && t1.results.every((m) => m.toolCallId <= 't2') && t1.images.length === 0, t1.results.map((m) => m.toolCallId).join(','))
  const already = trimPath.map((m) => (m.toolCallId === 't0' ? { ...m, trimmed: true } : m))
  check('a row already cleared is not chosen again', C.chooseTrim(already).results.length === 2)
  const small = trimPath.map((m) => (m.toolCallId === 't1' ? { ...m, content: 'ok' } : m))
  check('a short result is not worth a stub', C.chooseTrim(small).results.length === 2)
  const img = (n) => msg('user', 'see ' + n, { attachments: JSON.stringify([{ kind: 'image', size: 1, name: 'p' + n + '.png' }]) })
  const imgPath = [img(1), msg('assistant', 'a'), img(2), msg('assistant', 'b'), msg('user', 'plain text', { attachments: JSON.stringify([{ kind: 'text', size: 1, name: 't.txt' }]) }), msg('assistant', 'c'), img(3), msg('assistant', 'd'), img(4), msg('assistant', 'e'), img(5)]
  const t2 = C.chooseTrim(imgPath)
  check('images in the newest three messages stay, older ones go, a text attachment never counts', t2.images.length === 2 && t2.images[0].content === 'see 1' && t2.images[1].content === 'see 2', t2.images.map((m) => m.content).join(','))
  check('a stub says how big the result was and how it began', /900-character result that began "xxxx/.test(C.resultStub(big)) && C.resultStub(big).length < 200)
  check('a trimmed result is measured as its stub', C.messageTokens({ ...tool(0), trimmed: true }) < 80 && C.messageTokens(tool(0)) > 200)
  check('a trimmed message with an image no longer costs a picture', C.messageTokens({ ...img(1), trimmed: true }) < 60)

  console.log('\n-- what the summariser sees --')
  const t = C.transcriptOf(toolPath)
  check('tool calls are named', t.includes('[called read_file('))
  check('tool results are labelled', t.includes('TOOL RESULT:'))
  check('long output is clipped and says so',
    C.transcriptOf([msg('tool', 'x'.repeat(3000), { toolCallId: 't' })]).includes('more]'))
  check('failed messages are left out',
    !C.transcriptOf([msg('assistant', 'nope', { error: 'boom' })]).includes('nope'))

  console.log('\n-- the whole thing, against the database --')
  db.initDb()
  const project = db.createProject('compact', null)
  const conv = db.createConversation(project.id, 'x/y')
  let parent = null
  const ids = []
  for (let i = 0; i < 8; i++) {
    const m = db.addMessage(conv.id, parent, i % 2 ? 'assistant' : 'user', `${i}: ${words(150)}`, null)
    if (i % 2) db.finalizeMessage(m.id, { content: m.content, cost: 0.01 })
    ids.push(m.id); parent = m.id
  }
  const oldLeaf = parent
  const before = db.listMessages(conv.id).length
  let seen = ''
  const done = await compaction.compact(conv.id, oldLeaf, 300, async (transcript) => {
    seen = transcript
    return 'THE SUMMARY'
  })
  check('it happened', !!done && done.summarised > 0 && done.kept > 0, JSON.stringify(done))
  check('the summariser saw the older part only',
    seen.includes('0: word') && !seen.includes(`${8 - done.kept}: word`))
  const all = db.listMessages(conv.id)
  const root = all.find((m) => m.id === done.summaryId)
  check('the summary is a new root pointing at the old leaf',
    root && root.parentId === null && root.summaryOf === oldLeaf && root.role === 'user')
  check('it says how many it replaced', root.content.includes(`the ${done.summarised} earlier messages`))
  check('the conversation now sits on the new branch',
    db.getConversation(conv.id).leafId === done.leafId)
  const { pathToLeaf } = require('../out/test/entry.cjs').run.__proto__ ? {} : {}
  const walk = (leaf) => { const by = new Map(all.map((m) => [m.id, m])); const p = []; let n = by.get(leaf); while (n) { p.unshift(n); n = n.parentId ? by.get(n.parentId) : null } return p }
  const fresh = walk(done.leafId)
  check('the new branch is summary then the kept copies', fresh.length === 1 + done.kept &&
    fresh[1].content === walk(oldLeaf)[8 - done.kept].content)
  check('the original branch is untouched', walk(oldLeaf).length === 8 &&
    walk(oldLeaf).every((m, i) => m.id === ids[i]))
  check('copies carry no cost, so spend is not counted twice',
    fresh.slice(1).every((m) => m.cost === null) &&
    Math.abs(db.conversationCosts()[conv.id] - 0.04) < 1e-9, String(db.conversationCosts()[conv.id]))
  check('two roots now, so the switcher can reach both',
    all.filter((m) => m.parentId === null).length === 2)
  check('nothing was lost', all.length === before + 1 + done.kept)

  console.log('\n-- skills loaded before a summary ride on it --')
  const call = (name) => msg('assistant', '', { toolCalls: JSON.stringify([{ id: 'x', type: 'function', function: { name: 'load_skill', arguments: JSON.stringify({ name }) } }]) })
  check('the loads on a path are read in order, once each', compaction.skillsLoadedOn([msg('user', 'a'), call('alpha'), msg('tool', 'body'), call('beta'), call('alpha'), msg('assistant', 'x', { toolCalls: '{not json' })]).join(',') === 'alpha,beta')
  {
    const proj2 = db.createProject('carry', null)
    const conv2 = db.createConversation(proj2.id, 'x/y')
    const u1 = db.addMessage(conv2.id, null, 'user', 'first', null)
    const a1 = db.addMessage(conv2.id, u1.id, 'assistant', '', 'x/y', { toolCalls: JSON.stringify([{ id: 'c1', type: 'function', function: { name: 'load_skill', arguments: '{"name":"alpha"}' } }]) })
    const t1 = db.addMessage(conv2.id, a1.id, 'tool', 'Skill: alpha', null, { toolCallId: 'c1' })
    const u2 = db.addMessage(conv2.id, t1.id, 'user', 'second', null)
    const a2 = db.addMessage(conv2.id, u2.id, 'assistant', '', 'x/y', { toolCalls: JSON.stringify([{ id: 'c2', type: 'function', function: { name: 'load_skill', arguments: '{"name":"beta"}' } }]) })
    const t2 = db.addMessage(conv2.id, a2.id, 'tool', 'Skill: beta', null, { toolCallId: 'c2' })
    const before = db.listMessages(conv2.id)
    // A summary root, then the second exchange kept under it: alpha was in the summarised part, beta is still there.
    const root = db.addMessage(conv2.id, null, 'user', 'Summary of earlier.', null, { summaryOf: t2.id })
    const k1 = db.copyMessage(u2, root.id)
    const k2 = db.copyMessage(a2, k1.id)
    const k3 = db.copyMessage(t2, k2.id)
    const carried = await compaction.carrySkills(conv2.id, before, root.id, k3.id, async (name) => (name === 'alpha' ? 'ALPHA BODY' : name === 'beta' ? 'BETA BODY' : null))
    const summary = db.listMessages(conv2.id).find((m) => m.id === root.id).content
    check('a skill loaded only in the summarised part is carried onto the summary; one still loaded in the tail is not', carried.join(',') === 'alpha' && /## Skills in use/.test(summary) && /### alpha\n\nALPHA BODY/.test(summary) && !/BETA BODY/.test(summary), summary)
    check('a skill that no longer exists is skipped', (await compaction.carrySkills(conv2.id, [msg('assistant', '', { toolCalls: JSON.stringify([{ id: 'z', type: 'function', function: { name: 'load_skill', arguments: '{"name":"gone"}' } }]) })], root.id, k3.id, async () => null)).length === 0)
  }

  console.log('\n-- a summariser that fails leaves everything as it was --')
  const count = db.listMessages(conv.id).length
  let threw = false
  try { await compaction.compact(conv.id, oldLeaf, 300, async () => '') } catch { threw = true }
  check('an empty summary is an error', threw)
  check('and wrote nothing', db.listMessages(conv.id).length === count)

  console.log(`\n${pass} passed, ${fail} failed`)
  app.exit(fail === 0 ? 0 : 1)
}).catch((e) => { console.log('THREW ' + e.stack); app.exit(1) })
