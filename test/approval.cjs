const { app } = require('electron')

app.whenReady().then(async () => {
  const { approval: A, db } = require('../out/test/entry.cjs')
  const fs = require('fs'), path = require('path')
  let pass = 0, fail = 0
  const check = (label, ok, detail = '') => {
    console.log((ok ? 'ok    ' : 'FAIL  ') + label + (ok || !detail ? '' : ' -- ' + detail))
    ok ? pass++ : fail++
  }

  console.log('-- when the agent may run without asking --')
  check('off means ask', !A.autoApproves({ autoApprove: false, isRepo: true }) && A.autoApproveHeld({ autoApprove: false, isRepo: false }) === null)
  check('on, in a repository, runs', A.autoApproves({ autoApprove: true, isRepo: true }) && A.autoApproveHeld({ autoApprove: true, isRepo: true }) === null)
  check('on, outside one, still asks and says why', !A.autoApproves({ autoApprove: true, isRepo: false }) && /not under version control/.test(A.autoApproveHeld({ autoApprove: true, isRepo: false })))

  console.log('\n-- when the desktop is told --')
  check('the window in front means no notification', !A.shouldNotify({ focused: true, setting: null }))
  check('away from the window means one', A.shouldNotify({ focused: false, setting: null }) && A.shouldNotify({ focused: false, setting: '1' }))
  check('the setting turns it off', !A.shouldNotify({ focused: false, setting: '0' }))
  const n = A.approvalNotice({ conversationTitle: 'Fix the tide table', command: 'npm   test\n-- --grep tide' })
  check('the notice names the conversation and the command, on one line', n.title === 'Harbor is waiting on you' && n.body === 'Fix the tide table wants to run: npm test -- --grep tide', n.body)
  const long = A.approvalNotice({ conversationTitle: '', command: 'x'.repeat(300) })
  check('a long command is cut and an untitled conversation named', long.body.startsWith('A conversation wants to run: ') && long.body.endsWith('…') && long.body.length < 140)

  console.log('\n-- the project remembers --')
  const TMP = '/tmp/harbor-approval-test'; fs.rmSync(TMP, { recursive: true, force: true }); fs.mkdirSync(TMP, { recursive: true })
  app.setPath('userData', TMP)
  db.initDb()
  const p = db.createProject('p', TMP)
  check('off by default', p.autoApprove === false)
  db.updateProject(p.id, { autoApprove: true })
  check('on once set, and other fields untouched', db.getProject(p.id).autoApprove === true && db.getProject(p.id).name === 'p')
  db.updateProject(p.id, { name: 'q' })
  check('a patch without it leaves it alone', db.getProject(p.id).autoApprove === true && db.getProject(p.id).name === 'q')
  const { workspace: WS } = require('../out/test/entry.cjs')
  fs.mkdirSync(path.join(TMP, 'repo', 'deep', 'er'), { recursive: true }); fs.mkdirSync(path.join(TMP, 'repo', '.git'))
  check('a repository is known by its .git, at the folder or above it', (await WS.isRepo(path.join(TMP, 'repo', 'deep', 'er'))) && (await WS.isRepo(path.join(TMP, 'repo'))) && !(await WS.isRepo(path.join(TMP))))

  console.log(`\n${pass} passed, ${fail} failed`)
  app.exit(fail ? 1 : 0)
})
