const { app } = require('electron')

app.whenReady().then(async () => {
  const { db } = require('../out/test/entry.cjs')
  const fs = require('fs')
  let pass = 0, fail = 0
  const check = (label, ok, detail = '') => {
    console.log((ok ? 'ok    ' : 'FAIL  ') + label + (ok || !detail ? '' : ' -- ' + detail))
    ok ? pass++ : fail++
  }
  const TMP = '/tmp/harbor-scratch-test'; fs.rmSync(TMP, { recursive: true, force: true }); fs.mkdirSync(TMP, { recursive: true })
  app.setPath('userData', TMP)
  db.initDb()

  console.log('-- a quick question --')
  const p = db.createProject('p', null)
  const kept = db.createConversation(p.id, 'm')
  const quick = db.createConversation(p.id, 'm', true)
  check('an ordinary conversation is not scratch', kept.scratch === false && kept.title === 'Untitled')
  check('a quick question is, and says so', quick.scratch === true && quick.title === 'Quick question')
  check('both are listed for the app, flagged', db.listConversations().filter((c) => c.scratch).length === 1)
  const root = db.addMessage(quick.id, null, 'user', 'what is a halyard xylophone', 'm')
  db.addMessage(kept.id, null, 'user', 'the kept halyard xylophone', 'm')
  const found = db.searchEverything('halyard', 10)
  check('search never surfaces a quick question', found.every((r) => r.conversationId !== quick.id) && found.some((r) => r.conversationId === kept.id), JSON.stringify(found.map((r) => [r.kind, r.conversationId === quick.id])))
  db.renameConversation(quick.id, 'halyard question')
  check('nor by title', db.searchEverything('halyard question', 10).every((r) => r.conversationId !== quick.id))

  console.log('\n-- kept, or gone --')
  const quick2 = db.createConversation(p.id, 'm', true)
  db.keepConversation(quick2.id)
  check('kept means an ordinary conversation from then on', db.getConversation(quick2.id).scratch === false)
  const swept = db.purgeScratch()
  check('a sweep removes the throwaways and only them', swept === 1 && db.getConversation(quick.id) === null && db.getConversation(quick2.id) !== null && db.getConversation(kept.id) !== null, String(swept))
  check('and their messages with them', db.listMessages(quick.id).length === 0 && typeof root.id === 'string')
  check('a second sweep finds nothing', db.purgeScratch() === 0)

  console.log(`\n${pass} passed, ${fail} failed`)
  app.exit(fail ? 1 : 0)
})
