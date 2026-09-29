const { app } = require('electron')
const fs = require('fs')
const os = require('os')
const path = require('path')

const TMP = '/tmp/harbor-sandbox-test'
fs.rmSync(TMP, { recursive: true, force: true })
fs.mkdirSync(path.join(TMP, 'root'), { recursive: true })
app.setPath('userData', TMP)

app.whenReady().then(async () => {
  const { db, sandbox, commands } = require('../out/test/entry.cjs')
  let pass = 0, fail = 0
  const check = (label, ok, detail = '') => {
    console.log((ok ? 'ok    ' : 'FAIL  ') + label + (ok || !detail ? '' : ' -- ' + detail))
    ok ? pass++ : fail++
  }
  db.initDb()
  const root = path.join(TMP, 'root')
  const run = (cmd, box) => {
    let out = ''
    return commands.run('h-' + Math.random(), cmd, root, (t) => (out += t), 30_000, box).then((r) => ({ ...r, all: out }))
  }

  console.log('-- the runtime starts --')
  await sandbox.init()
  check('the sandbox is ready on this platform', sandbox.isReady(), sandbox.unavailable())
  check('the default domains are the registries and forges', sandbox.domains().includes('registry.npmjs.org') && sandbox.domains().includes('github.com'))
  db.setSetting('sandbox_domains', 'example.org\nfoo.test')
  check('domains from Settings replace the defaults', sandbox.domains().join(',') === 'example.org,foo.test')
  db.setSetting('sandbox_domains', '')
  if (!sandbox.isReady()) {
    console.log('sandbox unavailable here; the rest is skipped')
    console.log(`\n${pass} passed, ${fail} failed`)
    app.exit(fail === 0 ? 0 : 1)
    return
  }

  console.log('\n-- inside the fence --')
  const box = { root, id: 'c1' }
  const echo = await run('echo hi', box)
  check('a plain command runs and says it was sandboxed', echo.exitCode === 0 && /hi/.test(echo.output) && echo.sandboxed, JSON.stringify(echo).slice(0, 200))
  const inRoot = await run('echo made > made.txt && cat made.txt', box)
  check('the project folder is writable', inRoot.exitCode === 0 && fs.existsSync(path.join(root, 'made.txt')), inRoot.output.slice(0, 200))
  const probe = path.join(os.homedir(), `.harbor-sandbox-probe-${process.pid}`)
  const outside = await run(`touch "${probe}"`, box)
  const leaked = fs.existsSync(probe)
  if (leaked) fs.rmSync(probe)
  check('a write outside the project is refused', outside.exitCode !== 0 && !leaked, outside.output.slice(0, 300))
  check('and the refusal is explained in the output', /sandbox/i.test(outside.output), outside.output.slice(0, 300))
  const net = await run('curl -sS -m 8 https://example.com/ -o /dev/null && echo reached', box)
  check('a host that is not allowed is not reached', !/reached/.test(net.output), net.output.slice(0, 300))
  const secret = await run(`ls "${path.join(os.homedir(), '.ssh')}" 2>&1; ls "${path.join(os.homedir(), '.aws')}" 2>&1; echo done`, box)
  check('the key folders cannot be listed', !/id_|credentials|config\n/.test(secret.output) && /done/.test(secret.output), secret.output.slice(0, 300))

  console.log('\n-- outside it --')
  const plain = await run('echo hi', undefined)
  check('without the box a command runs as before and says so', plain.exitCode === 0 && /hi/.test(plain.output) && plain.sandboxed === false)

  console.log(`\n${pass} passed, ${fail} failed`)
  app.exit(fail === 0 ? 0 : 1)
}).catch((e) => { console.log('THREW ' + e.stack); app.exit(1) })
