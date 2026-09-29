const { app } = require('electron')
const fs = require('fs')
const path = require('path')

const TMP = '/tmp/harbor-tools-test'
fs.rmSync(TMP, { recursive: true, force: true })
fs.mkdirSync(TMP, { recursive: true })
app.setPath('userData', TMP)

app.whenReady().then(async () => {
  const { agentTools: T, db, activity: A, spill: S } = require('../out/test/entry.cjs')
  let pass = 0, fail = 0
  const check = (label, ok, detail = '') => {
    console.log((ok ? 'ok    ' : 'FAIL  ') + label + (ok || !detail ? '' : ' -- ' + detail))
    ok ? pass++ : fail++
  }
  db.initDb()
  const root = path.join(TMP, 'root')
  fs.mkdirSync(root, { recursive: true })
  const ctx = {
    projectId: null, webUsed: () => false, root, unlocked: [],
    runId: 'r', conversationId: 'c', plan: false, writeGlobs: [],
    onTodos: () => {}, onWrote: () => {}, runCommand: async () => '', afterWrite: async () => ''
  }
  const read = (p) => fs.readFileSync(path.join(root, p), 'utf8')

  console.log('-- the registry offers the same tools in the same order --')
  const names = (o) => T.toolSchemas(o).map((t) => t.function.name).join(' ')
  const all = { hasWorkspace: true, hasSkills: true, hasKnowledge: true }
  check('a full agent turn, in the order the cache has seen', names(all) === 'read_file list_dir search write_file edit_file run_command todo_write command_output stop_command load_skill search_knowledge ask_oracle', names(all))
  check('a chat may delegate; plan mode takes it away', names({ ...all, role: 'chat' }) === 'read_file list_dir search write_file edit_file run_command todo_write command_output stop_command delegate load_skill search_knowledge ask_oracle' && !names({ ...all, role: 'chat', plan: true }).includes('delegate'), names({ ...all, role: 'chat' }))
  check('a worker also asks', names({ ...all, role: 'worker' }) === 'read_file list_dir search write_file edit_file run_command todo_write command_output stop_command ask_person load_skill search_knowledge ask_oracle', names({ ...all, role: 'worker' }))
  check('an approved director reads, writes, runs, and briefs', names({ ...all, role: 'director', approved: true }) === 'read_file list_dir search write_file edit_file run_command todo_write command_output stop_command load_skill search_knowledge ask_oracle dispatch continue_task', names({ ...all, role: 'director', approved: true }))
  check('a director before approval, and an interviewer, read and write their own files', names({ ...all, role: 'director' }) === 'read_file list_dir search write_file edit_file load_skill search_knowledge ask_oracle' && names({ ...all, role: 'interview' }) === names({ ...all, role: 'director' }), names({ ...all, role: 'director' }))
  check('no folder, no file tools', names({ hasWorkspace: false, hasSkills: true, hasKnowledge: false }) === 'load_skill ask_oracle')
  let sent = null
  const dctx = { ...ctx, delegate: async (s) => { sent = s; return 'report' } }
  check('delegate shapes its brief', (await T.execute(dctx, 'delegate', { title: 'Survey', brief: 'read src and summarise', owns: ['docs/**'], max_spend: 0.2 })) === 'report' && sent.title === 'Survey' && sent.owns.join() === 'docs/**' && sent.maxSpend === 0.2 && sent.readOnly === false && sent.model === undefined)
  check('spend is capped and defaulted', (await T.execute(dctx, 'delegate', { title: 't', brief: 'b', max_spend: 50 }), sent.maxSpend === 5) && (await T.execute(dctx, 'delegate', { title: 't', brief: 'b' }), sent.maxSpend === 0.5))
  let asked = null
  const octx = { ...ctx, askOracle: async (q, m) => { asked = { q, m }; return 'Oracle says' } }
  check('ask_oracle passes the question and the material', (await T.execute(octx, 'ask_oracle', { question: 'Is this right?', material: 'diff' })) === 'Oracle says' && asked.q === 'Is this right?' && asked.m === 'diff')
  check('and needs a question', await T.execute(octx, 'ask_oracle', { question: ' ' }).then(() => false, (e) => /Ask something/.test(e.message)))
  check('no brief, no worker', await T.execute(dctx, 'delegate', { title: 't', brief: '' }).then(() => false, (e) => /brief is empty/.test(e.message)))
  check('every tool has a verb for the waiting line', T.TOOLS.every((t) => A.DOING[t.schema.function.name]), T.TOOLS.map((t) => t.schema.function.name).filter((n) => !A.DOING[n]).join(' '))
  check('every tool names its subject', T.TOOLS.every((t) => typeof t.subject({}) === 'string'))
  check('an unknown tool is an error, not a silent nothing', await T.execute(ctx, 'no_such_tool', {}).then(() => false, (e) => /Unknown tool/.test(e.message)))

  console.log('\n-- edit_file writes the new text as given --')
  fs.writeFileSync(path.join(root, 'a.txt'), 'price is 5 dollars\n')
  await T.execute(ctx, 'edit_file', { path: 'a.txt', old_string: '5 dollars', new_string: "$5 or $' more, $& said" })
  check('dollar signs are not substitution patterns', read('a.txt') === "price is $5 or $' more, $& said\n", JSON.stringify(read('a.txt')))
  fs.writeFileSync(path.join(root, 'b.txt'), 'x\nx\n')
  await T.execute(ctx, 'edit_file', { path: 'b.txt', old_string: 'x', new_string: '$1', replace_all: true })
  check('and not with replace_all either', read('b.txt') === '$1\n$1\n', JSON.stringify(read('b.txt')))

  console.log('\n-- a miss names the nearest line --')
  fs.writeFileSync(path.join(root, 'c.ts'), 'import x from "y"\n\nexport function total(items: Item[]): number {\n  return items.length\n}\n')
  let msg = ''
  try { await T.execute(ctx, 'edit_file', { path: 'c.ts', old_string: 'export function total(items: Item[]) {', new_string: 'z' }) } catch (e) { msg = e.message }
  check('the error points at the line that nearly matched', /closest line is 3: export function total/.test(msg), msg)
  try { await T.execute(ctx, 'edit_file', { path: 'c.ts', old_string: 'nothing like this at all qqq', new_string: 'z' }) } catch (e) { msg = e.message }
  check('and offers nothing when nothing is close', !/closest line/.test(msg), msg)
  check('nearestLine on an empty wanted string is null', T.nearestLine('a\nb', '  \n') === null)

  console.log('\n-- arguments are held to the schema --')
  const schema = (name) => T.toolSchemas({ hasWorkspace: true, hasSkills: true, hasKnowledge: true }).find((t) => t.function.name === name)
  check('a complete call passes', T.validateArgs(schema('edit_file'), { path: 'a', old_string: 'b', new_string: 'c' }) === null)
  check('a missing required field is named', /old_string/.test(T.validateArgs(schema('edit_file'), { path: 'a', new_string: 'c' }) ?? ''), T.validateArgs(schema('edit_file'), { path: 'a', new_string: 'c' }))
  check('a wrong type is named', /replace_all should be a boolean/.test(T.validateArgs(schema('edit_file'), { path: 'a', old_string: 'b', new_string: 'c', replace_all: 'yes' }) ?? ''))
  check('an integer where a number is asked is fine', T.validateArgs(schema('read_file'), { path: 'a', offset: 3 }) === null, T.validateArgs(schema('read_file'), { path: 'a', offset: 3 }))
  check('an unknown tool or no schema is not judged', T.validateArgs(undefined, { anything: 1 }) === null)

  console.log('\n-- a result too large to carry is saved and shown by its head --')
  const smallOut = 'fits'
  check('a result that fits is untouched', (await S.spillIfLarge('req-1234-abcd', 'call_1', 'read_file', smallOut)) === smallOut)
  const bigOut = Array.from({ length: 3000 }, (_, i) => `line ${i + 1} ` + 'z'.repeat(20)).join('\n')
  const shown = await S.spillIfLarge('req-1234-abcd', 'call_1', 'read_file', bigOut)
  check('the head is shown and the rest named', shown.length < bigOut.length && shown.startsWith('line 1 ') && /characters \(3,000 lines\)/.test(shown) && /read_file on that path/.test(shown), shown.slice(-200))
  const savedPath = (shown.match(/saved at (\S+\.txt)/) || [])[1]
  check('the whole result is on file', !!savedPath && fs.readFileSync(savedPath, 'utf8') === bigOut, savedPath)
  check('the saved file is under the tool-results folder and nothing else is', S.isSpillPath(savedPath) && !S.isSpillPath(path.join(root, 'a.txt')) && !S.isSpillPath('/etc/passwd'))
  const page = await S.readSpilled(savedPath, 100, 5)
  check('it reads back by offset and limit, numbered, saying how to continue', /^  101\tline 101 /.test(page) && page.split('\n').length === 6 && /continue with offset 105/.test(page), page)
  const viaTool = await T.execute(ctx, 'read_file', { path: savedPath, offset: 0, limit: 2 })
  check('read_file reaches a saved result, and only there', /^    1\tline 1 /.test(viaTool) && (await T.execute(ctx, 'read_file', { path: '/etc/passwd' }).then(() => false, () => true)))
  check('a path that is not a saved result is refused by the reader', await S.readSpilled(path.join(root, 'a.txt')).then(() => false, (e) => /not a saved tool result/.test(e.message)))
  fs.utimesSync(path.dirname(savedPath), new Date(Date.now() - 40 * 86_400_000), new Date(Date.now() - 40 * 86_400_000))
  check('old results are swept, recent ones kept', (await S.sweepSpills(30 * 86_400_000)) === 1 && !fs.existsSync(savedPath))

  console.log(`\n${pass} passed, ${fail} failed`)
  app.exit(fail === 0 ? 0 : 1)
}).catch((e) => { console.log('THREW ' + e.stack); app.exit(1) })
