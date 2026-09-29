const { app } = require('electron')
const fs = require('fs')
const path = require('path')

const TMP = '/tmp/harbor-mcp-test'
fs.rmSync(TMP, { recursive: true, force: true })
fs.mkdirSync(TMP, { recursive: true })
app.setPath('userData', TMP)

app.whenReady().then(async () => {
  const { db, mcp, agentTools: T } = require('../out/test/entry.cjs')
  let pass = 0, fail = 0
  const check = (label, ok, detail = '') => {
    console.log((ok ? 'ok    ' : 'FAIL  ') + label + (ok || !detail ? '' : ' -- ' + detail))
    ok ? pass++ : fail++
  }
  db.initDb()
  const fixture = path.join(__dirname, 'fixtures', 'mcp-echo.mjs')
  const all = { hasWorkspace: true, hasSkills: false, hasKnowledge: false }
  const names = (o) => T.toolSchemas(o).map((t) => t.function.name)

  console.log('-- before any server --')
  check('find_tools is not offered with no server', !names(all).includes('find_tools'))
  db.setSetting('mcp_servers', JSON.stringify([{ name: 'Echo Fixture', command: process.execPath, args: [fixture] }, { name: 'broken', command: '/nonexistent/binary' }, { name: 'off', command: 'x', enabled: false }]))

  console.log('\n-- connecting --')
  await mcp.init()
  const st = mcp.status()
  const echo = st.find((s) => s.name === 'echo-fixture')
  check('the fixture connected with its four tools', echo && echo.connected && echo.tools === 4, JSON.stringify(st))
  check('a server that cannot start is listed with its error, and the rest carry on', st.find((s) => s.name === 'broken')?.connected === false && !!st.find((s) => s.name === 'broken')?.error)
  check('a server turned off is not connected and has no error', st.find((s) => s.name === 'off')?.connected === false && st.find((s) => s.name === 'off')?.error === null)
  check('tools carry their read-only hint', mcp.toolByName('mcp__echo-fixture__echo')?.readOnly === true && mcp.toolByName('mcp__echo-fixture__write_note')?.readOnly === false)

  console.log('\n-- deferred schemas --')
  check('find_tools is offered now, and the server tools are not', names(all).includes('find_tools') && !names(all).some((n) => n.startsWith('mcp__')))
  const loaded = new Set()
  let listing = ''
  const ctx = { projectId: null, webUsed: () => false, root: TMP, unlocked: [], runId: 'r', conversationId: 'c', plan: false, writeGlobs: [], onTodos: () => {}, onWrote: () => {}, runCommand: async () => '', afterWrite: async () => '',
    findTools: async (q) => { const found = mcp.listing().filter((t) => !q || t.name.split("__").pop().includes(q)); for (const t of found) loaded.add(t.name); listing = found.map((t) => t.name).join(','); return listing },
    callMcp: (server, tool, args) => mcp.call(server, tool, args) }
  await T.execute(ctx, 'find_tools', { query: 'echo' })
  check('a found tool is loaded and its schema rides along', loaded.has('mcp__echo-fixture__echo') && names({ ...all, loaded }).includes('mcp__echo-fixture__echo') && !names({ ...all, loaded }).includes('mcp__echo-fixture__big'))
  check('the loaded schema is the server\'s', JSON.stringify(T.toolSchemas({ ...all, loaded }).find((t) => t.function.name === 'mcp__echo-fixture__echo').function.parameters.properties).includes('text'))
  check('a write tool is withheld in plan mode like any other', !names({ ...all, loaded: new Set(['mcp__echo-fixture__write_note']), plan: true }).includes('mcp__echo-fixture__write_note') && names({ ...all, loaded: new Set(['mcp__echo-fixture__echo']), plan: true }).includes('mcp__echo-fixture__echo'))

  console.log('\n-- calling --')
  check('a call goes through the registry to the server', (await T.execute(ctx, 'mcp__echo-fixture__echo', { text: 'hello' })) === 'HELLO')
  check('the subject line is the first string argument', T.subjectOf('mcp__echo-fixture__echo', { text: 'hello there' }) === 'hello there')
  check('a failing tool is an error with the server\'s words', await T.execute(ctx, 'mcp__echo-fixture__fail', {}).then(() => false, (e) => /it broke/.test(e.message)))
  const big = await mcp.call('echo-fixture', 'big', {})
  check('a huge result is cut at the cap', big.length < 210_000 && /cut at 200,000/.test(big))
  check('an unknown tool on a known server says to look', await T.execute(ctx, 'mcp__echo-fixture__nope', {}).then(() => false, (e) => /find_tools/.test(e.message)))
  check('a tool on a server that is not connected says so', await mcp.call('broken', 'x', {}).then(() => false, (e) => /not connected/.test(e.message)))

  console.log('\n-- reconnecting --')
  db.setSetting('mcp_servers', '')
  await mcp.init()
  check('with the setting cleared, nothing is connected and find_tools goes', mcp.status().length === 0 && !names(all).includes('find_tools'))
  db.setSetting('mcp_servers', '{oops')
  await mcp.init()
  check('a bad setting is reported, not thrown', /Not JSON/.test(mcp.configured().error) && mcp.status().length === 0)

  await mcp.closeAll()
  console.log(`\n${pass} passed, ${fail} failed`)
  app.exit(fail === 0 ? 0 : 1)
}).catch((e) => { console.log('THREW ' + e.stack); app.exit(1) })
