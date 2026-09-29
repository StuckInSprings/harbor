import { parseGoalCommand, parseEval, decide, evalMessages, continueMessage, CONTINUE_PREFIX, MAX_TURNS, DEFAULT_BUDGET, IDLE_TURNS } from '../out/test/goal.mjs'

let pass = 0, fail = 0
const check = (label, ok, detail = '') => { console.log((ok ? 'ok    ' : 'FAIL  ') + label + (ok || !detail ? '' : ' -- ' + detail)); ok ? pass++ : fail++ }

console.log('-- the command --')
check('/goal off, stop, clear and nothing all clear', ['off', 'stop', 'clear', '', '  '].every((a) => 'off' in parseGoalCommand(a)))
check('a condition with the default budget', JSON.stringify(parseGoalCommand('all tests pass')) === JSON.stringify({ goal: 'all tests pass', budget: DEFAULT_BUDGET }))
check('a trailing dollar amount is the budget', JSON.stringify(parseGoalCommand('all tests pass $3.50')) === JSON.stringify({ goal: 'all tests pass', budget: 3.5 }))
check('a dollar sign inside the text is not a budget', parseGoalCommand('earn $5 a day for me').goal === 'earn $5 a day for me')
check('a bare budget with no goal is an error', 'error' in parseGoalCommand('$5'))

console.log('\n-- the judge\'s line --')
check('MET with evidence', JSON.stringify(parseEval('MET: 12 tests passed in the output.')) === JSON.stringify({ verdict: 'met', note: '12 tests passed in the output' }))
check('NOT YET with what is missing', parseEval('NOT YET: the file was written but the tests were not run').verdict === 'not-yet')
check('IMPOSSIBLE', parseEval('**impossible**: there is no such command').verdict === 'impossible')
check('anything unclear is not yet, and the loop carries on', parseEval('Looks good to me.').verdict === 'not-yet' && /no clear answer/.test(parseEval('').note))

console.log('\n-- what happens next --')
const facts = (o = {}) => ({ turns: 1, maxTurns: MAX_TURNS, spent: 0.1, budget: 2, toolCalls: 3, idleBefore: 0, failed: false, cancelled: false, ...o })
const notYet = { verdict: 'not-yet', note: 'tests not run' }
check('not yet, within limits: continue with the note', JSON.stringify(decide(notYet, facts())) === JSON.stringify({ state: 'pursuing', note: 'tests not run', continue: true, idle: 0 }))
check('met ends it', decide({ verdict: 'met', note: 'passed' }, facts()).state === 'met' && !decide({ verdict: 'met', note: 'passed' }, facts()).continue)
check('impossible is unmet', decide({ verdict: 'impossible', note: 'no' }, facts()).state === 'unmet')
check('the person\'s stop comes before the judge', decide({ verdict: 'met', note: 'x' }, facts({ cancelled: true })).state === 'stopped')
check('a failed turn ends it', decide(null, facts({ failed: true })).state === 'failed')
check('the budget', decide(notYet, facts({ spent: 2 })).state === 'budget' && /2\.00 of \$2\.00/.test(decide(notYet, facts({ spent: 2 })).note))
check('the turn limit', decide(notYet, facts({ turns: MAX_TURNS })).state === 'turns')
check('no tools once is not a stall; twice in a row is', decide(notYet, facts({ toolCalls: 0 })).state === 'pursuing' && decide(notYet, facts({ toolCalls: 0 })).idle === 1 && decide(notYet, facts({ toolCalls: 0, idleBefore: IDLE_TURNS - 1 })).state === 'stalled')
check('a tool call resets the idle count', decide(notYet, facts({ toolCalls: 2, idleBefore: 5 })).idle === 0)
check('met wins over the budget being spent at the same time', decide({ verdict: 'met', note: 'x' }, facts({ spent: 9 })).state === 'met')

console.log('\n-- what the judge and the model are shown --')
const msgs = evalMessages({ goal: 'tests pass', said: ['make the tests pass', ''], reply: 'Done, I ran them.', tools: ['run_command npm test', 'read_file a.ts'] })
check('the goal, the person, the tools and the reply, each named', /The goal:\ntests pass/.test(msgs[1].content) && /1\. make the tests pass/.test(msgs[1].content) && /run_command npm test/.test(msgs[1].content) && /The last reply:\nDone, I ran them\./.test(msgs[1].content))
check('a turn with no tools says none', /Tools the last turn called: none/.test(evalMessages({ goal: 'g', said: [], reply: 'r', tools: [] })[1].content))
check('the system rule asks for evidence, not claims', /A claim without evidence is NOT YET/.test(msgs[0].content))
const cont = continueMessage('tests pass', 'tests not run')
check('the continue message is marked as Harbor\'s and says what is missing', cont.startsWith(CONTINUE_PREFIX) && /Not yet met: tests not run/.test(cont))

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
