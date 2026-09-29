const { app } = require('electron')
const fs = require('fs')

const TMP = '/tmp/harbor-drafts-test'
fs.rmSync(TMP, { recursive: true, force: true })
fs.mkdirSync(TMP, { recursive: true })
app.setPath('userData', TMP)

app.whenReady().then(async () => {
  const { db, diff: D } = require('../out/test/entry.cjs')
  let pass = 0, fail = 0
  const check = (label, ok, detail = '') => {
    console.log((ok ? 'ok    ' : 'FAIL  ') + label + (ok || !detail ? '' : ' -- ' + detail))
    ok ? pass++ : fail++
  }

  console.log('-- the diff --')
  const d = D.diffLines('a\nb\nc', 'a\nx\nc\nd')
  check('a change is a removal and an addition', d.map((l) => l.kind).join('') === ' -+ +', d.map((l) => l.kind).join(''))
  check('counts', JSON.stringify(D.changeCounts(d)) === '{"added":2,"removed":1}')
  check('identical is all context', D.diffLines('a\nb', 'a\nb').every((l) => l.kind === ' '))
  const long = D.withContext(D.diffLines(Array.from({ length: 30 }, (_, i) => `l${i}`).join('\n'), Array.from({ length: 30 }, (_, i) => (i === 15 ? 'CHANGED' : `l${i}`)).join('\n')))
  check('long unchanged runs collapse to a note', long.some((l) => /unchanged lines/.test(l.text)) && long.length < 15, String(long.length))

  console.log('\n-- a file\'s history across the project --')
  db.initDb()
  const p = db.createProject('drafts', null)
  const other = db.createProject('other', null)
  const a = db.createConversation(p.id, 'x/y'); db.renameConversation && db.renameConversation(a.id, 'First pass')
  const b = db.createConversation(p.id, 'x/y')
  const c = db.createConversation(other.id, 'x/y')
  db.addCheckpoint({ runId: 'r1', conversationId: a.id, path: 'story.md', beforeHash: null, afterHash: 'h1', created: true })
  db.addCheckpoint({ runId: 'r2', conversationId: b.id, path: 'story.md', beforeHash: 'h1', afterHash: 'h2', created: false })
  db.addCheckpoint({ runId: 'r3', conversationId: b.id, path: 'notes.md', beforeHash: null, afterHash: 'h9', created: true })
  db.addCheckpoint({ runId: 'r4', conversationId: c.id, path: 'story.md', beforeHash: null, afterHash: 'h7', created: true })
  const hist = db.listPathCheckpoints(p.id, 'story.md')
  check('every conversation in the project, newest first', hist.length === 2 && hist[0].hash === 'h2' && hist[1].hash === 'h1', JSON.stringify(hist.map((v) => v.hash)))
  check('not other files, not other projects', !hist.some((v) => v.hash === 'h9' || v.hash === 'h7'))
  check('each version names its conversation', hist.every((v) => typeof v.conversationTitle === 'string'))
  check('the first write is marked as creating the file', hist[1].created === true && hist[0].created === false)

  console.log(`\n${pass} passed, ${fail} failed`)
  app.exit(fail === 0 ? 0 : 1)
}).catch((e) => { console.log('THREW ' + e.stack); app.exit(1) })
