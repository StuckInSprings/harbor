const { app } = require('electron')

app.whenReady().then(() => {
  const { activity: A } = require('../out/test/entry.cjs')
  let pass = 0, fail = 0
  const check = (label, ok, detail = '') => {
    console.log((ok ? 'ok    ' : 'FAIL  ') + label + (ok || !detail ? '' : ' -- ' + detail))
    ok ? pass++ : fail++
  }
  const at = (phase, ago, detail) => ({ phase, detail, since: Date.now() - ago })
  const now = () => Date.now()

  console.log('-- the line names what is being waited on --')
  check('the model, while waiting',
    A.activityLabel({ phase: 'waiting', detail: 'kimi-k2' }) === 'Waiting on kimi-k2',
    A.activityLabel({ phase: 'waiting', detail: 'kimi-k2' }))
  check('and still says something without one',
    A.activityLabel({ phase: 'waiting' }) === 'Waiting on the model')
  check('a person, when it is a person',
    A.activityLabel({ phase: 'approval' }) === 'Waiting for you')
  check('every phase has a label',
    ['assembling','sending','waiting','thinking','writing','tool','approval']
      .every((p) => (A.activityLabel({ phase: p }) || '').length > 3))

  console.log('\n-- tools are named in the present tense --')
  check('one call reads as an action',
    A.toolLabel([{ name: 'run_command', subject: 'npm test' }]) === 'Running npm test',
    A.toolLabel([{ name: 'run_command', subject: 'npm test' }]))
  check('a subjectless tool does not trail a space',
    A.toolLabel([{ name: 'todo_write', subject: '3 items' }]) === 'Updating the checklist')
  check('several are counted rather than listed',
    A.toolLabel([{ name: 'read_file', subject: 'a' }, { name: 'read_file', subject: 'b' }])
      === 'Running 2 tools')
  check('an unknown tool falls back to its name',
    A.toolLabel([{ name: 'mystery', subject: 'x' }]) === 'mystery x')

  console.log('\n-- the reassurance is the real deadline, not a platitude --')
  check('nothing is said in the first seconds',
    A.activityNote(at('waiting', 3000), now()) === null)
  const note = A.activityNote(at('waiting', 30_000), now())
  check('after a while it says when it gives up', /Gives up in 2m 00s/.test(note), note)
  check('the countdown tracks the watchdog',
    A.activityNote(at('waiting', A.FIRST_BYTE_MS - 5000), now()).includes('5s'),
    A.activityNote(at('waiting', A.FIRST_BYTE_MS - 5000), now()))
  check('and admits when the deadline has passed',
    A.activityNote(at('waiting', A.FIRST_BYTE_MS + 1000), now()).includes('Past the deadline'))
  check('an approval says nothing is moving until you answer',
    A.activityNote(at('approval', 1000), now()).includes('until you answer'))

  console.log('\n-- the clock reads the way a clock should --')
  check('seconds under a minute', A.formatElapsed(9400) === '9s', A.formatElapsed(9400))
  check('minutes above one', A.formatElapsed(64_000) === '1m 04s', A.formatElapsed(64_000))
  check('never negative', A.formatElapsed(-500) === '0s')

  console.log('\n-- the thought shown is the end of the trace --')
  const short = 'Let me check the tests.'
  check('a short trace is shown whole', A.thoughtTail(short) === short)
  const long = 'A'.repeat(200) + '. The user asked about the parser, so I should read it.'
  check('a long one keeps the newest words',
    A.thoughtTail(long).includes('read it.') && A.thoughtTail(long).length <= 141,
    A.thoughtTail(long))
  check('newlines do not break the single line',
    !A.thoughtTail('one\n\ntwo').includes('\n'))
  check('an empty trace stays empty', A.thoughtTail('') === '')

    console.log('\n-- a long tool keeps a pulse --')
  check('the pulse says what and for how long', A.stillRunning('dispatch T1, T2', 45_000) === 'dispatch T1, T2 · 45s' && A.stillRunning('x', 200_000) === 'x · 3m 20s')
  check('the run tools have verbs', A.toolLabel([{ name: 'dispatch', subject: 'T1, T2' }]) === 'Waiting on workers T1, T2' && A.toolLabel([{ name: 'ask_oracle', subject: 'the plan' }]) === 'Asking the oracle about the plan')

console.log(`\n${pass} passed, ${fail} failed`)
  app.exit(fail === 0 ? 0 : 1)
}).catch((e) => { console.log('THREW ' + e.stack); app.exit(1) })
