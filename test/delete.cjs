const { app } = require('electron')
const fs = require('fs')

const TMP = '/tmp/harbor-delete-test'
fs.rmSync(TMP, { recursive: true, force: true })
fs.mkdirSync(TMP, { recursive: true })
app.setPath('userData', TMP)

app.whenReady().then(() => {
  const { db, tree } = require('../out/test/entry.cjs')
  let pass = 0, fail = 0
  const check = (label, ok, detail = '') => {
    console.log((ok ? 'ok    ' : 'FAIL  ') + label + (ok || !detail ? '' : ' -- ' + detail))
    ok ? pass++ : fail++
  }

  db.initDb()
  const project = db.createProject('del', null)

  /** user -> assistant -> user -> assistant, as a real exchange builds it. */
  const build = () => {
    const c = db.createConversation(project.id, 'm')
    const a = db.addMessage(c.id, null, 'user', 'first question', null)
    const b = db.addMessage(c.id, a.id, 'assistant', 'first answer', 'm')
    const d = db.addMessage(c.id, b.id, 'user', 'second question', null)
    const e = db.addMessage(c.id, d.id, 'assistant', 'second answer', 'm')
    return { c, ids: [a.id, b.id, d.id, e.id] }
  }

  const visible = (convId) => {
    const conv = db.getConversation(convId)
    return tree.pathTo(db.listMessages(convId), conv.leafId).map((m) => m.content)
  }

  const labels = ['first question', 'first answer', 'second question', 'second answer']

  for (let i = 0; i < 4; i++) {
    const { c, ids } = build()
    db.deleteMessage(ids[i])
    const left = visible(c.id)
    const expected = labels.filter((_, j) => j !== i)
    check(`deleting "${labels[i]}" leaves the other three`,
      JSON.stringify(left) === JSON.stringify(expected),
      `got ${JSON.stringify(left)}`)
  }

  console.log('\n-- tool results go with the call that made them --')
  {
    const c = db.createConversation(project.id, 'm')
    const u = db.addMessage(c.id, null, 'user', 'do a thing', null)
    const a = db.addMessage(c.id, u.id, 'assistant', '', 'm', { toolCalls: '[{"id":"t1"}]' })
    const t = db.addMessage(c.id, a.id, 'tool', 'Listed 3 entries', null, { toolCallId: 't1' })
    const f = db.addMessage(c.id, t.id, 'assistant', 'all done', 'm')

    db.deleteMessage(a.id)
    const left = db.listMessages(c.id)
    check('the orphaned tool result is gone too',
      !left.some((m) => m.id === t.id), JSON.stringify(left.map((m) => m.role)))
    check('what followed is re-attached to the question',
      left.find((m) => m.id === f.id)?.parentId === u.id)
    check('and the whole thing still reads',
      JSON.stringify(visible(c.id)) === JSON.stringify(['do a thing', 'all done']),
      JSON.stringify(visible(c.id)))
  }

  console.log('\n-- other branches are untouched --')
  {
    const c = db.createConversation(project.id, 'm')
    const u = db.addMessage(c.id, null, 'user', 'question', null)
    const first = db.addMessage(c.id, u.id, 'assistant', 'answer one', 'm')
    const second = db.addMessage(c.id, u.id, 'assistant', 'answer two', 'm')

    db.deleteMessage(first.id)
    const left = db.listMessages(c.id)
    check('the sibling branch survives', left.some((m) => m.id === second.id))
    check('and is still what you see',
      JSON.stringify(visible(c.id)) === JSON.stringify(['question', 'answer two']),
      JSON.stringify(visible(c.id)))
  }

  console.log('\n-- deleting the last message moves the leaf back --')
  {
    const c = db.createConversation(project.id, 'm')
    const u = db.addMessage(c.id, null, 'user', 'only question', null)
    const a = db.addMessage(c.id, u.id, 'assistant', 'only answer', 'm')
    db.deleteMessage(a.id)
    check('the leaf follows to the parent', db.getConversation(c.id).leafId === u.id,
      String(db.getConversation(c.id).leafId))
    check('and the question is still there',
      JSON.stringify(visible(c.id)) === JSON.stringify(['only question']),
      JSON.stringify(visible(c.id)))
  }

  console.log('\n-- repairing chains an older version broke --')
  {
    const c = db.createConversation(project.id, 'm')
    const a = db.addMessage(c.id, null, 'user', 'q1', null)
    const b = db.addMessage(c.id, a.id, 'assistant', 'a1', 'm')
    const d = db.addMessage(c.id, b.id, 'user', 'q2', null)
    const e = db.addMessage(c.id, d.id, 'assistant', 'a2', 'm')

    // Exactly the damage the old delete did: remove a row, orphan the rest.
    db.rawDeleteForTest(b.id)
    check('the break hides the earlier half',
      JSON.stringify(visible(c.id)) === JSON.stringify(['q2', 'a2']),
      JSON.stringify(visible(c.id)))

    db.repairBrokenChains()
    check('repair reconnects what was left',
      JSON.stringify(visible(c.id)) === JSON.stringify(['q1', 'q2', 'a2']),
      JSON.stringify(visible(c.id)))
    check('and it is a no-op the second time',
      (db.repairBrokenChains(), JSON.stringify(visible(c.id))) ===
        JSON.stringify(['q1', 'q2', 'a2']))
  }

  console.log(`\n${pass} passed, ${fail} failed`)
  app.exit(fail === 0 ? 0 : 1)
}).catch((e) => { console.log('THREW ' + e.stack); app.exit(1) })
