const { app } = require('electron')
const fs = require('fs')
const path = require('path')

const TMP = '/tmp/harbor-hooks-test'
fs.rmSync(TMP, { recursive: true, force: true })
fs.mkdirSync(path.join(TMP, 'root', 'src'), { recursive: true })
app.setPath('userData', TMP)

app.whenReady().then(async () => {
  const { hooks: H, hookRunner, agentTools: T, db } = require('../out/test/entry.cjs')
  let pass = 0, fail = 0
  const check = (label, ok, detail = '') => {
    console.log((ok ? 'ok    ' : 'FAIL  ') + label + (ok || !detail ? '' : ' -- ' + detail))
    ok ? pass++ : fail++
  }
  const m = (glob, p) => H.hookMatches({ glob, command: 'x' }, p)

  console.log('-- patterns --')
  check('a bare name pattern matches anywhere', m('*.ts', 'src/deep/a.ts') && m('*.ts', 'a.ts'))
  check('and not the wrong extension', !m('*.ts', 'src/a.tsx'))
  check('alternatives', m('*.{ts,tsx}', 'src/a.tsx') && !m('*.{ts,tsx}', 'a.js'))
  check('a directory pattern is anchored', m('src/**/*.ts', 'src/a.ts') && m('src/**/*.ts', 'src/x/y/a.ts') && !m('src/**/*.ts', 'lib/a.ts'))
  check('a single star stays inside one directory', m('src/*.ts', 'src/a.ts') && !m('src/*.ts', 'src/x/a.ts'))
  check('an exact file', m('package.json', 'package.json') && !m('package.json', 'sub/package.jsonx'))
  check('star alone matches everything', m('*', 'any/thing.at.all') && m('**', 'x'))
  check('a leading ./ is tolerated on both sides', m('./src/*.ts', './src/a.ts'))
  check('regex characters are literal', !m('a.ts', 'aXts') && m('a+b.ts', 'a+b.ts'))

  console.log('\n-- the command line --')
  check('{path} is substituted, quoted', H.substitute('fmt {path}', 'src/my file.ts') === "fmt 'src/my file.ts'")
  check('a quote in the path survives', H.substitute('x {path}', "it's.ts") === "x 'it'\\''s.ts'")
  check('no placeholder, no change', H.substitute('npm test', 'a.ts') === 'npm test')

  console.log('\n-- what the model reads --')
  const okReport = H.hookReport({ glob: '*', command: 'tsc' }, { output: '', exitCode: 0, timedOut: false })
  check('a clean run is one line', okReport === '[hook: tsc] ok', okReport)
  const bad = H.hookReport({ glob: '*', command: 'tsc' }, { output: 'a.ts(1,2): error TS2304', exitCode: 2, timedOut: false })
  check('a failure names the exit code and shows the output', bad.includes('exit code 2') && bad.includes('TS2304'))
  const long = H.hookReport({ glob: '*', command: 'x' }, { output: 'a'.repeat(5000) + 'END', exitCode: 1, timedOut: false })
  check('long output keeps the end, where the summary is', long.endsWith('END') && long.includes('earlier characters cut'))
  check('a timeout says so', H.hookReport({ glob: '*', command: 'x', timeoutSec: 5 }, { output: '', exitCode: null, timedOut: true }).includes('timed out after 5s'))

  console.log('\n-- parsing what was saved --')
  check('garbage is an empty list', H.parseHooks('nope').length === 0 && H.parseHooks('{}').length === 0)
  check('blank rows are dropped', H.parseHooks('[{"glob":" ","command":"x"},{"glob":"*","command":"y"}]').length === 1)

  console.log('\n-- for real, in a folder --')
  const root = path.join(TMP, 'root')
  const events = []
  const text = await hookRunner.runHooks({
    root, path: 'src/a.ts', conversationId: 'c',
    hooks: [
      { glob: '*.ts', command: 'echo hooked {path}; exit 3' },
      { glob: '*.md', command: 'echo should not run' },
      { glob: '*', command: 'rm -rf /' }
    ],
    emitTerminal: (e) => events.push(e)
  })
  check('the matching hook ran with the path', text.includes("hooked src/a.ts"), text)
  check('its exit code came back', text.includes('exit code 3'))
  check('the non-matching hook did not', !text.includes('should not run'))
  check('the deny list still applies to hooks', text.includes('refused') && !events.some((e) => e.command && e.command.startsWith('rm')))
  check('it streamed to the terminal as a hook', events.some((e) => e.type === 'start' && e.source === 'hook'))
  check('no hooks, no text', (await hookRunner.runHooks({ root, path: 'a', conversationId: 'c', hooks: [], emitTerminal: () => {} })) === '')

  console.log('\n-- through the tool, as the agent would --')
  db.initDb()
  let ran = ''
  const ctx = {
    projectId: null, webUsed: () => false, root, unlocked: [], runId: 'r', conversationId: 'c', plan: false, writeGlobs: [],
    onTodos: () => {}, onWrote: () => {}, runCommand: async () => '',
    afterWrite: async (p) => { ran = p; return '[hook: fake] ok' }
  }
  const out = await T.execute(ctx, 'write_file', { path: 'src/b.ts', content: 'export {}\n' })
  check('the hook ran after the write, and the model reads both', ran === 'src/b.ts' && out.startsWith('Wrote src/b.ts.') && out.includes('[hook: fake] ok'), out)

  console.log('\n-- persisted with the project --')
  const p = db.createProject('hooked', root)
  db.updateProject(p.id, { hooks: [{ glob: '*.ts', command: 'npx tsc --noEmit' }, { glob: '', command: 'dropped' }] })
  const back = db.getProject(p.id)
  check('saved and read back, blanks dropped', back.hooks.length === 1 && back.hooks[0].command === 'npx tsc --noEmit', JSON.stringify(back.hooks))

  console.log(`\n${pass} passed, ${fail} failed`)
  app.exit(fail === 0 ? 0 : 1)
}).catch((e) => { console.log('THREW ' + e.stack); app.exit(1) })
