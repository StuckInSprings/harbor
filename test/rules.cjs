const { app } = require('electron')
const fs = require('fs')
const path = require('path')

const TMP = '/tmp/harbor-rules-test'
fs.rmSync(TMP, { recursive: true, force: true })
fs.mkdirSync(path.join(TMP, 'repo'), { recursive: true })
app.setPath('userData', TMP)

app.whenReady().then(async () => {
  const { db, rules: R, context: C } = require('../out/test/entry.cjs')
  let pass = 0, fail = 0
  const check = (label, ok, detail = '') => {
    console.log((ok ? 'ok    ' : 'FAIL  ') + label + (ok || !detail ? '' : ' -- ' + detail))
    ok ? pass++ : fail++
  }
  const repo = path.join(TMP, 'repo')

  console.log('-- which file is read --')
  check('no folder, no rules', (await R.readRules(null)) === null)
  check('an empty folder, no rules', (await R.readRules(repo)) === null)
  fs.writeFileSync(path.join(repo, 'CLAUDE.md'), 'Use tabs.\n')
  let r = await R.readRules(repo)
  check('CLAUDE.md is read when it is all there is', r && r.name === 'CLAUDE.md' && r.text === 'Use tabs.')
  fs.writeFileSync(path.join(repo, 'AGENTS.md'), 'Use spaces.\n')
  r = await R.readRules(repo)
  check('AGENTS.md wins when both exist', r && r.name === 'AGENTS.md' && r.text === 'Use spaces.', JSON.stringify(r))
  fs.writeFileSync(path.join(repo, 'AGENTS.md'), '   \n')
  r = await R.readRules(repo)
  check('a blank AGENTS.md falls through to CLAUDE.md', r && r.name === 'CLAUDE.md')

  console.log('\n-- size --')
  fs.writeFileSync(path.join(repo, 'AGENTS.md'), 'x'.repeat(R.RULES_CAP + 500))
  r = await R.readRules(repo)
  check('a huge file is cut, and says so', r.truncated && r.text.length === R.RULES_CAP)
  check('the block tells the model it was cut', R.rulesBlock(r).includes('was cut here'))
  fs.writeFileSync(path.join(repo, 'AGENTS.md'), 'Prefer small commits.')
  r = await R.readRules(repo)
  check('the block names its source', R.rulesBlock(r).startsWith('# AGENTS.md'))

  console.log('\n-- it reaches the prompt, where the inspector can see it --')
  db.initDb()
  const project = db.createProject('rules', repo)
  const sys = await C.assembleSystem({ projectId: project.id, model: 'x/y', web: false })
  const section = sys.sections.find((s) => s.label === 'Rules (AGENTS.md)')
  check('a Rules section is present', !!section, sys.sections.map((s) => s.label).join(' | '))
  check('with the file contents', section && section.text.includes('Prefer small commits.'))
  check('it is one section, not a paragraph in another',
    sys.sections.filter((s) => s.text.includes('Prefer small commits.')).length === 1)

  console.log('\n-- plan mode is said in the prompt too --')
  const planned = await C.assembleSystem({ projectId: project.id, model: 'x/y', web: false, plan: true })
  check('a Plan mode section appears', planned.sections.some((s) => s.label === 'Plan mode'))
  const labels = planned.sections.map((s) => s.label)
  check('rules come before the plan note, so the note is read as a constraint on them',
    labels.indexOf('Rules (AGENTS.md)') < labels.indexOf('Plan mode'), labels.join(' | '))
  check('and not otherwise', !sys.sections.some((s) => s.label === 'Plan mode'))
  check('it tells the model the tools are gone, not just discouraged',
    C.PLAN_NOTE.includes('not available'))

  const noRoot = db.createProject('bare', null)
  const bare = await C.assembleSystem({ projectId: noRoot.id, model: 'x/y', web: false })
  check('a project without a folder has no Rules section',
    !bare.sections.some((s) => s.label.startsWith('Rules')))

  console.log('\n-- rules nearer the file than the root --')
  const mk = (rel, text) => { fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); fs.writeFileSync(path.join(repo, rel), text) }
  mk('src/api/AGENTS.md', 'Every handler returns a Result.')
  mk('src/CLAUDE.md', 'Components are functions.')
  mk('.claude/rules/tests.md', '---\npaths:\n  - "**/*.test.ts"\n  - test/**\n---\nOne assertion per behaviour.')
  mk('.agents/rules/sql.md', '---\npaths: ["**/*.sql", "db/**"]\n---\nNo string-built SQL.')
  mk('.claude/rules/no-paths.md', 'Applies to nothing, since it names no paths.')
  const at = async (rel) => (await R.rulesForPath(repo, rel)).map((x) => x.label)
  check('the nearest nested file wins, and the root is not repeated', (await at('src/api/users.ts')).join(',') === 'src/api/AGENTS.md')
  check('a file with no nested rules above it gets the next folder up', (await at('src/ui/Button.tsx')).join(',') === 'src/CLAUDE.md')
  check('a file at the root gets none', (await at('README.md')).length === 0)
  check('a rules file applies where its paths say, and not elsewhere', (await at('src/api/users.test.ts')).join(',') === 'src/api/AGENTS.md,.claude/rules/tests.md' && (await at('db/schema.sql')).join(',') === '.agents/rules/sql.md' && !(await at('src/x.ts')).includes('.claude/rules/tests.md'))
  check('a rules file with no paths applies nowhere', !(await at('anything.md')).includes('.claude/rules/no-paths.md'))
  check('the paths line reads a list or a bracketed line', R.pathsOf('---\npaths:\n  - a/**\n  - "b/*.md"\n---').join(',') === 'a/**,b/*.md' && R.pathsOf('---\npaths: [x, "y"]\n---').join(',') === 'x,y' && R.pathsOf('no front matter').length === 0)
  const block = R.scopedBlock(await R.rulesForPath(repo, 'src/api/users.ts'))
  check('the block names where each rule came from', /\[Instructions that apply here, from src\/api\/AGENTS.md:\nEvery handler returns a Result.\]/.test(block), block)
  mk('src/big/AGENTS.md', 'y'.repeat(R.NESTED_CAP + 100))
  check('a nested file is cut', (await R.rulesForPath(repo, 'src/big/x.ts'))[0].text.length < R.NESTED_CAP + 60)

  console.log(`\n${pass} passed, ${fail} failed`)
  app.exit(fail === 0 ? 0 : 1)
}).catch((e) => { console.log('THREW ' + e.stack); app.exit(1) })
