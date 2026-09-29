const { app } = require('electron')
const fs = require('fs')

const TMP = '/tmp/harbor-memory-test'
fs.rmSync(TMP, { recursive: true, force: true })
fs.mkdirSync(TMP, { recursive: true })
app.setPath('userData', TMP)

app.whenReady().then(async () => {
  const { db, memory: M } = require('../out/test/entry.cjs')
  let pass = 0, fail = 0
  const check = (label, ok, detail = '') => {
    console.log((ok ? 'ok    ' : 'FAIL  ') + label + (ok || !detail ? '' : ' -- ' + detail))
    ok ? pass++ : fail++
  }
  db.initDb()
  const p = db.createProject('mem', null)
  const c = db.createConversation(p.id, 'x/y')
  const u = db.addMessage(c.id, null, 'user', 'hi', null)

  console.log('-- what the extractor says --')
  check('the new form carries an origin', JSON.stringify(M.parseExtraction('{"memories":[{"text":"The person prefers tabs over spaces.","origin":"person"},{"text":"The build needs Node 24.","origin":"model"}],"outdated":["Uses Node 20."]}')) === JSON.stringify({ memories: [{ text: 'The person prefers tabs over spaces.', origin: 'person' }, { text: 'The build needs Node 24.', origin: 'model' }], outdated: ['Uses Node 20.'] }))
  check('the old form still reads, as the model\'s', JSON.stringify(M.parseExtraction('text before {"memories":["The tests live under test/."]} after').memories) === JSON.stringify([{ text: 'The tests live under test/.', origin: 'model' }]))
  check('too short, too long, and non-strings are dropped', M.parseExtraction('{"memories":["short",{"text":' + JSON.stringify('x'.repeat(400)) + '},7,{"text":"A fact that is long enough to keep."}]}').memories.length === 1)
  check('nothing, or not JSON, is nothing', M.parseExtraction('').memories.length === 0 && M.parseExtraction('{oops').memories.length === 0 && M.parseExtraction('{"memories":"no"}').outdated.length === 0)

  console.log('\n-- rows: origin, review, invalidation --')
  const own = db.addMemory({ projectId: p.id, text: 'Written by the person.', sourceConvId: null, sourceMsgId: null, extractedBy: null, origin: 'person' })
  check('a memory the person writes is theirs, reviewed and on', own.origin === 'person' && own.reviewed && own.enabled)
  const waiting = db.addMemory({ projectId: p.id, text: 'Waiting for a look.', sourceConvId: c.id, sourceMsgId: u.id, extractedBy: 'x/y', origin: 'model', reviewed: false })
  check('a memory that waits is off and unreviewed, and listed first', !waiting.enabled && !waiting.reviewed && db.listMemories(p.id)[0].id === waiting.id)
  check('the prompt block leaves it out', !M.block(p.id, 5000).text.includes('Waiting for a look') && M.block(p.id, 5000).text.includes('Written by the person'))
  db.reviewMemory(waiting.id, true)
  check('kept, it is on and in the block', db.listMemories(p.id).find((m) => m.id === waiting.id).enabled && M.block(p.id, 5000).text.includes('Waiting for a look'))
  db.reviewMemory(waiting.id, false)
  check('dropped, it is reviewed and off, and stays on file', !db.listMemories(p.id).find((m) => m.id === waiting.id).enabled && db.listMemories(p.id).find((m) => m.id === waiting.id).reviewed)
  db.invalidateMemory(own.id, 'the person changed their mind')
  const stale = db.listMemories(p.id).find((m) => m.id === own.id)
  check('an invalidated memory is kept, marked, off, and out of the block', !!stale && stale.invalidatedAt > 0 && stale.invalidatedBy === 'the person changed their mind' && !stale.enabled && !M.block(p.id, 5000).text.includes('Written by the person'))
  db.invalidateMemory(own.id, 'again')
  check('invalidating twice keeps the first reason', db.listMemories(p.id).find((m) => m.id === own.id).invalidatedBy === 'the person changed their mind')

  console.log('\n-- extraction end to end, with a scripted model --')
  const fact = db.addMemory({ projectId: p.id, text: 'The API lives on port 3000.', sourceConvId: c.id, sourceMsgId: u.id, extractedBy: 'x/y' })
  const reply = JSON.stringify({ memories: [{ text: 'The API now lives on port 4000.', origin: 'person' }, { text: 'The API lives on port 3000.', origin: 'model' }], outdated: ['The API lives on port 3000.'] })
  db.setSetting('memory_review', '0')
  const added = await M.extract({ projectId: p.id, conversationId: c.id, messageId: u.id, exchange: [{ role: 'user', content: 'we moved the api to port 4000 yesterday, remember that' }, { role: 'assistant', content: 'Noted.' }], model: 'x/y', ask: async () => reply })
  const after = db.listMemories(p.id)
  check('the new fact is added with its origin, the old one is invalidated and names the newer', added === 1 && after.some((m) => m.text.includes('port 4000') && m.origin === 'person' && m.enabled) && after.find((m) => m.id === fact.id).invalidatedAt > 0 && /port 4000/.test(after.find((m) => m.id === fact.id).invalidatedBy))
  check('a repeat of a known fact is not added twice', !after.filter((m) => m.text === 'The API lives on port 3000.').some((m, i, all) => all.length > 1))
  db.setSetting('memory_review', '1')
  const added2 = await M.extract({ projectId: p.id, conversationId: c.id, messageId: u.id, exchange: [{ role: 'user', content: 'also, we always run lint before pushing, that is the rule' }, { role: 'assistant', content: 'Understood.' }], model: 'x/y', ask: async () => '{"memories":[{"text":"Lint runs before every push.","origin":"person"}]}' })
  const queued = db.listMemories(p.id).find((m) => m.text === 'Lint runs before every push.')
  check('with review on, a new memory waits and is not in the block', added2 === 1 && queued && !queued.reviewed && !queued.enabled && !M.block(p.id, 5000).text.includes('Lint runs'))
  check('a model that fails yields nothing and no error', (await M.extract({ projectId: p.id, conversationId: c.id, messageId: u.id, exchange: [{ role: 'user', content: 'x'.repeat(50) }], model: 'x/y', ask: async () => { throw new Error('down') } })) === 0)

  console.log(`\n${pass} passed, ${fail} failed`)
  app.exit(fail === 0 ? 0 : 1)
}).catch((e) => { console.log('THREW ' + e.stack); app.exit(1) })
