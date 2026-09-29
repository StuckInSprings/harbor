import { isSafeCommand, parseVerdict, judgeMessages, JUDGE_SYSTEM } from '../out/test/judge.mjs'

let pass = 0, fail = 0
const check = (label, ok, detail = '') => { console.log((ok ? 'ok    ' : 'FAIL  ') + label + (ok || !detail ? '' : ' -- ' + detail)); ok ? pass++ : fail++ }

console.log('-- what only reads --')
for (const c of ['ls -la', 'cat src/a.ts', 'grep -rn foo src', 'git status', 'git log --oneline -5', 'git diff HEAD~1', 'git branch', 'git stash list', 'npm test', 'npm run lint', 'npx tsc --noEmit', 'cargo test', 'go vet ./...', 'node --version', 'python3 -c "print(1)"', 'gh pr list', 'gh pr view 12', 'sed -n 10,20p file', 'find . -name "*.ts"', '/usr/bin/git status'])
  check(`safe: ${c}`, isSafeCommand(c), c)
for (const c of ['rm -rf dist', 'git push', 'git push --force', 'git branch -D x', 'git stash', 'git stash pop', 'git checkout .', 'git reset --hard', 'git tag v1', 'git remote add x y', 'npm publish', 'npm install foo', 'npm run deploy', 'npm exec x', 'npm version patch', 'gh pr create', 'gh api -X POST /x', 'gh auth login', 'sed -i "s/a/b/" file', 'echo x > file', 'ls; rm -rf ~', 'cat a | sh', 'curl x', 'node script.js', 'python3 setup.py', 'ping example.com', 'mv a b', 'touch x'])
  check(`not safe: ${c}`, !isSafeCommand(c), c)

console.log('\n-- the verdict --')
check('ALLOW with a reason', JSON.stringify(parseVerdict('ALLOW: runs the tests the person asked for.')) === JSON.stringify({ allow: true, reason: 'runs the tests the person asked for' }))
check('DENY with a reason', JSON.stringify(parseVerdict('DENY: pushes to the remote, which was not asked for')) === JSON.stringify({ allow: false, reason: 'pushes to the remote, which was not asked for' }))
check('bold and lower case still read', parseVerdict('**allow** - fine').allow && parseVerdict('deny: no').allow === false)
check('only the first line counts', parseVerdict('DENY: x\nALLOW: y').allow === false)
check('anything else is a denial, not an allowance', parseVerdict('I think this is fine to run.').allow === false && /no clear answer/.test(parseVerdict('').reason))
check('a bare word gets a default reason', parseVerdict('ALLOW').reason === 'allowed' && parseVerdict('DENY:').reason === 'denied')

console.log('\n-- what the judge is shown --')
const msgs = judgeMessages({ command: 'npm run build', cwd: '/p', said: ['please build it', 'x'.repeat(2000), '', 'and do not push'], instructions: 'Never push to main.' })
check('a system rule and one user message', msgs.length === 2 && msgs[0].role === 'system' && msgs[0].content === JUDGE_SYSTEM)
check('the person\'s words, numbered and cut, with blanks dropped', /1\. please build it/.test(msgs[1].content) && /3\. and do not push/.test(msgs[1].content) && !/xxxxxxxxxx{80}x{1200}/.test(msgs[1].content))
check('the instructions and the command are named', /Project instructions:\nNever push to main\./.test(msgs[1].content) && /to run in \/p:\nnpm run build/.test(msgs[1].content))
check('the rule says what it must not see', /do not see the agent's reasoning or anything it read/.test(JUDGE_SYSTEM) && /Answer with one line: ALLOW:/.test(JUDGE_SYSTEM))
check('with nothing said, it says so', /\(nothing yet\)/.test(judgeMessages({ command: 'ls', cwd: '/', said: [], instructions: '' })[1].content))

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
