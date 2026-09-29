/**
 * Runs the test suites: one bundle, then every suite, then one summary.
 *
 *   node test/run.cjs            every suite
 *   node test/run.cjs jail deny  only those
 *   PARALLEL=1 node test/run.cjs one at a time
 *
 * The suites stay as separate scripts in their own processes, because most of
 * them point Electron's userData at a temp folder of their own and initialise
 * the database module there, and that module is a singleton. What this file
 * removes is the twenty-seven identical rebuilds of the same bundle, and the
 * `&&` chain that stopped at the first failure and hid every suite after it.
 * Every suite runs; the exit code is non-zero if any of them failed.
 */
const { execFileSync, spawn } = require('child_process')
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const OUT = path.join(ROOT, 'out', 'test')
const ESBUILD = path.join(ROOT, 'node_modules', '.bin', 'esbuild')
const ELECTRON = require('electron')
const NATIVE = ['electron', 'better-sqlite3', 'sqlite-vec', '@huggingface/transformers', 'unpdf', '@anthropic-ai/sandbox-runtime', '@modelcontextprotocol/sdk']
/** Long enough for the knowledge suite to load its model; far shorter than a hang. */
const SUITE_LIMIT_MS = 300_000

// Under Node (not Electron): the jail and the deny list, which must not need a window.
const NODE_SUITES = {
  jail: { bundle: 'electron/main/workspace.ts', out: 'workspace.mjs' },
  sse: { bundle: 'electron/main/sse.ts', out: 'sse.mjs' },
  cache: { bundle: 'shared/cache.ts', out: 'cache.mjs' },
  judge: { bundle: 'shared/judge.ts', out: 'judge.mjs' },
  mcpconf: { bundle: 'shared/mcp.ts', out: 'mcpconf.mjs' },
  goal: { bundle: 'shared/goal.ts', out: 'goal.mjs' },
  deny: {
    bundle: 'electron/main/commands.ts',
    out: 'commands.mjs',
    noBundle: true,
    // commands.ts reads the allowlist from the database; the deny test wants none.
    patch: (src) =>
      src
        .replace(/^import \* as db from ["']\.\/db["'];?$/m, 'const db = { listAllowedCommands: () => [] };')
        .replace(/^import \* as sandbox from ["']\.\/sandbox["'];?$/m, 'const sandbox = { wrap: async () => null, explain: (c, o) => o, after: () => {}, isReady: () => false, unavailable: () => "" };'),
  },
}

function build() {
  fs.mkdirSync(OUT, { recursive: true })
  const run = (args) => execFileSync(ESBUILD, args, { cwd: ROOT, stdio: 'inherit' })
  run(['test/entry.ts', '--bundle', '--platform=node', '--format=cjs', ...NATIVE.map((n) => `--external:${n}`), `--outfile=${path.join(OUT, 'entry.cjs')}`, '--log-level=error'])
  for (const s of Object.values(NODE_SUITES)) {
    const outfile = path.join(OUT, s.out)
    run([s.bundle, ...(s.noBundle ? [] : ['--bundle', '--packages=external']), '--format=esm', '--platform=node', `--outfile=${outfile}`, '--log-level=error'])
    if (s.patch) fs.writeFileSync(outfile, s.patch(fs.readFileSync(outfile, 'utf8')))
  }
}

function listSuites() {
  return fs
    .readdirSync(__dirname)
    .filter((f) => /\.(cjs|mjs)$/.test(f) && f !== 'run.cjs')
    .map((f) => f.replace(/\.(cjs|mjs)$/, ''))
    .sort()
}

function runSuite(name) {
  const mjs = path.join(__dirname, `${name}.mjs`)
  const isNode = fs.existsSync(mjs)
  const file = isNode ? mjs : path.join(__dirname, `${name}.cjs`)
  const [cmd, args] = isNode ? [process.execPath, [file]] : [ELECTRON, [file]]
  return new Promise((resolve) => {
    const started = Date.now()
    let output = ''
    const child = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, ELECTRON_ENABLE_LOGGING: '0' } })
    /*
      Electron does not exit on an error thrown while a script loads: it
      puts up a dialog and waits, which as a test is a hang. So is a suite
      that never prints its tally. Either is killed and reported as crashed.
    */
    let killed = ''
    const kill = (why) => {
      if (killed) return
      killed = why
      child.kill('SIGKILL')
    }
    const limit = setTimeout(() => kill(`no tally after ${SUITE_LIMIT_MS / 1000}s`), SUITE_LIMIT_MS)
    const watch = (d) => {
      output += d
      if (/App threw an error during load/.test(output)) kill('threw while loading')
    }
    child.stdout.on('data', watch)
    child.stderr.on('data', watch)
    child.on('close', (code) => {
      clearTimeout(limit)
      const m = /(\d+) passed, (\d+) failed/.exec(output)
      resolve({
        name,
        code,
        ms: Date.now() - started,
        passed: m ? Number(m[1]) : 0,
        failed: m ? Number(m[2]) : 0,
        output,
        // A suite that never printed its tally crashed before the end.
        crashed: !m,
        killed,
      })
    })
  })
}

async function main() {
  const wanted = process.argv.slice(2)
  const all = listSuites()
  const unknown = wanted.filter((w) => !all.includes(w))
  if (unknown.length) {
    console.error(`No such suite: ${unknown.join(', ')}. Have: ${all.join(', ')}`)
    process.exit(2)
  }
  const suites = wanted.length ? wanted : all
  const parallel = Math.max(1, Number(process.env.PARALLEL) || 4)

  const t0 = Date.now()
  build()
  console.log(`built in ${((Date.now() - t0) / 1000).toFixed(1)}s; running ${suites.length} suites, ${parallel} at a time\n`)

  const results = []
  const queue = [...suites]
  const worker = async () => {
    for (let s = queue.shift(); s; s = queue.shift()) {
      const r = await runSuite(s)
      results.push(r)
      const bad = r.code !== 0 || r.failed > 0 || r.crashed
      console.log(`${bad ? 'FAIL' : 'ok  '}  ${s.padEnd(12)} ${String(r.passed).padStart(3)} passed ${String(r.failed).padStart(2)} failed  ${(r.ms / 1000).toFixed(1)}s${r.crashed ? `  (no tally: ${r.killed || 'crashed'})` : ''}`)
    }
  }
  await Promise.all(Array.from({ length: parallel }, worker))

  const bad = results.filter((r) => r.code !== 0 || r.failed > 0 || r.crashed)
  for (const r of bad) {
    console.log(`\n===== ${r.name} =====`)
    console.log(r.output.split('\n').filter((l) => !/^ok\s/.test(l)).join('\n').trim())
  }
  const passed = results.reduce((n, r) => n + r.passed, 0)
  const failed = results.reduce((n, r) => n + r.failed, 0)
  console.log(`\n${passed} passed, ${failed} failed across ${results.length} suites in ${((Date.now() - t0) / 1000).toFixed(1)}s${bad.length ? `; ${bad.length} suite(s) red: ${bad.map((r) => r.name).join(', ')}` : ''}`)
  process.exit(bad.length ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
