const { app } = require('electron')

app.whenReady().then(async () => {
  const { agentTools: T } = require('../out/test/entry.cjs')
  let pass = 0, fail = 0
  const check = (label, ok, detail = '') => {
    console.log((ok ? 'ok    ' : 'FAIL  ') + label + (ok || !detail ? '' : ' -- ' + detail))
    ok ? pass++ : fail++
  }
  const names = (opts) => T.toolSchemas(opts).map((t) => t.function.name)
  const all = { hasWorkspace: true, hasSkills: true, hasKnowledge: true }

  console.log('-- plan mode withholds exactly the tools that change things --')
  const full = names(all)
  const plan = names({ ...all, plan: true })
  check('the full set has the write tools',
    ['write_file', 'edit_file', 'run_command'].every((n) => full.includes(n)), full.join(' '))
  check('plan mode has none of them',
    ['write_file', 'edit_file', 'run_command'].every((n) => !plan.includes(n)), plan.join(' '))
  check('and keeps every read',
    ['read_file', 'list_dir', 'search', 'load_skill', 'search_knowledge'].every((n) =>
      plan.includes(n)), plan.join(' '))
  check('the checklist survives, since a plan is what it is for', plan.includes('todo_write'))
  check('nothing else was lost',
    full.filter((n) => !T.WRITE_TOOLS.has(n)).join() === plan.join(), plan.join(' '))

  console.log('\n-- a model that calls a write anyway is refused, not obeyed --')
  let wrote = false
  const ctx = {
    projectId: null, webUsed: () => false, root: '/nowhere', unlocked: [],
    runId: 'r', conversationId: 'c', plan: true, writeGlobs: [],
    onTodos: () => {}, onWrote: () => { wrote = true },
    runCommand: async () => { wrote = true; return 'ran' }
  }
  const w = await T.execute(ctx, 'write_file', { path: 'x.txt', content: 'hi' })
  check('write_file is refused', w.startsWith('Refused: plan mode'), w)
  const c = await T.execute(ctx, 'run_command', { command: 'rm -rf /' })
  check('run_command is refused', c.startsWith('Refused: plan mode'), c)
  check('and nothing ran', wrote === false)
  const t = await T.execute(ctx, 'todo_write', { todos: [] })
  check('todo_write still works', !t.startsWith('Refused'), t)

  console.log(`\n${pass} passed, ${fail} failed`)
  app.exit(fail === 0 ? 0 : 1)
}).catch((e) => { console.log('THREW ' + e.stack); app.exit(1) })
