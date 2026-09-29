import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import * as ws from '../out/test/workspace.mjs'

const ROOT = '/tmp/harbor-jail-test/root'
await fs.rm('/tmp/harbor-jail-test', { recursive: true, force: true })
await fs.mkdir(join(ROOT, 'docs'), { recursive: true })
await fs.mkdir(join(ROOT, '.git'), { recursive: true })
await fs.mkdir(join(ROOT, 'node_modules', 'pkg'), { recursive: true })
await fs.writeFile(join(ROOT, 'docs', 'note.md'), '# hello\nsecond line\n')
await fs.writeFile(join(ROOT, '.env'), 'SECRET=hunter2\n')
await fs.writeFile(join(ROOT, '.git', 'config'), '[core]\n')
await fs.writeFile(join(ROOT, 'node_modules', 'pkg', 'index.js'), 'module.exports=1\n')
await fs.writeFile(join(ROOT, 'key.pem'), 'PRIVATE KEY\n')
await fs.mkdir('/tmp/harbor-jail-test/outside', { recursive: true })
await fs.writeFile('/tmp/harbor-jail-test/outside/secret.txt', 'not yours\n')
await fs.symlink('/tmp/harbor-jail-test/outside', join(ROOT, 'escape'))
await fs.writeFile(join(ROOT, 'id_rsa'), 'PRIVATE\n')
await fs.symlink(join(ROOT, '.git'), join(ROOT, 'gitlink'))
await fs.symlink(join(ROOT, '.env'), join(ROOT, 'envlink'))
await fs.symlink('/tmp/harbor-jail-test/outside/secret.txt', join(ROOT, 'leak.txt'))
await fs.symlink(join(ROOT, 'docs', 'note.md'), join(ROOT, 'alias.md'))

let pass = 0, fail = 0
const denies = async (label, fn) => {
  try { await fn(); console.log('FAIL  (allowed)  ' + label); fail++ }
  catch { console.log('ok    (blocked)  ' + label); pass++ }
}
const allows = async (label, fn) => {
  try { await fn(); console.log('ok    (allowed)  ' + label); pass++ }
  catch (e) { console.log('FAIL  (blocked)  ' + label + '  -- ' + e.message); fail++ }
}

await allows('docs/note.md', () => ws.resolveInside(ROOT, 'docs/note.md'))
await allows('nested new file', () => ws.resolveInside(ROOT, 'a/b/c/new.txt'))
await denies('../../etc/passwd', () => ws.resolveInside(ROOT, '../../etc/passwd'))
await denies('absolute /etc/passwd', () => ws.resolveInside(ROOT, '/etc/passwd'))
await denies('docs/../../outside', () => ws.resolveInside(ROOT, 'docs/../../outside/secret.txt'))
await denies('.git/config', () => ws.resolveInside(ROOT, '.git/config'))
await denies('.env', () => ws.resolveInside(ROOT, '.env'))
await denies('.env.local', () => ws.resolveInside(ROOT, '.env.local'))
await denies('node_modules/pkg/index.js', () => ws.resolveInside(ROOT, 'node_modules/pkg/index.js'))
await denies('key.pem', () => ws.resolveInside(ROOT, 'key.pem'))
await denies('symlink escape/secret.txt', () => ws.resolveInside(ROOT, 'escape/secret.txt'))
await denies('symlink dir itself', () => ws.resolveInside(ROOT, 'escape'))

const listing = await ws.listDir(ROOT, '.')
console.log('\nlist_dir hides denied entries:',
  !listing.includes('.git') && !listing.includes('node_modules') && !listing.includes('.env')
    ? 'ok' : 'FAIL -- ' + JSON.stringify(listing))

const body = await ws.readFile(ROOT, 'docs/note.md')
console.log('read_file numbers lines:', body.includes('1\t# hello') ? 'ok' : 'FAIL -- ' + body)

const hits = await ws.search(ROOT, 'second')
console.log('search finds content:', hits.includes('docs/note.md:2') ? 'ok' : 'FAIL -- ' + hits)

const leak = await ws.search(ROOT, 'hunter2')
console.log('search cannot reach .env:', leak.startsWith('No matches') ? 'ok' : 'FAIL -- ' + leak)

console.log('\n-- a link inside the project is where it points, not what it is called --')
await denies('gitlink/config -> .git/config', () => ws.readFile(ROOT, 'gitlink/config'))
await denies('write gitlink/hooks/pre-commit', () => ws.writeRaw(ROOT, 'gitlink/hooks/pre-commit', 'x'))
await denies('envlink -> .env', () => ws.readFile(ROOT, 'envlink'))
await denies('leak.txt -> outside the project', () => ws.readFile(ROOT, 'leak.txt'))
await allows('alias.md -> docs/note.md', () => ws.readFile(ROOT, 'alias.md'))
const viaLeak = await ws.search(ROOT, 'not yours')
console.log('search does not follow a link out of the project:', viaLeak.startsWith('No matches') ? 'ok' : 'FAIL -- ' + viaLeak)
const viaEnvlink = await ws.search(ROOT, 'hunter2')
console.log('search does not follow a link into .env:', viaEnvlink.startsWith('No matches') ? 'ok' : 'FAIL -- ' + viaEnvlink)
const viaAlias = await ws.search(ROOT, 'second')
console.log('search does follow a link to an ordinary file:', viaAlias.includes('alias.md:2') ? 'ok' : 'FAIL -- ' + viaAlias)
if (viaLeak.startsWith('No matches') && viaEnvlink.startsWith('No matches') && viaAlias.includes('alias.md:2')) pass += 3; else fail++

console.log('\n-- the deny list does not care about case --')
await denies('.GIT/config', () => ws.resolveInside(ROOT, '.GIT/config'))
await denies('.ENV', () => ws.resolveInside(ROOT, '.ENV'))
await denies('ID_RSA', () => ws.resolveInside(ROOT, 'ID_RSA'))
await denies('Node_Modules/pkg/index.js', () => ws.resolveInside(ROOT, 'Node_Modules/pkg/index.js'))
await denies('KEY.PEM', () => ws.resolveInside(ROOT, 'KEY.PEM'))
const upper = await ws.listDir(ROOT, '.')
console.log('list_dir hides denied names whatever their case:', !/\.GIT|\.ENV|node_modules/i.test(upper) ? 'ok' : 'FAIL -- ' + upper)
if (!/\.GIT|\.ENV|node_modules/i.test(upper)) pass++; else fail++

console.log('\n-- unlocking opens one category only --')
await allows('git unlocked -> gitlink/config', () => ws.readFile(ROOT, 'gitlink/config', 0, 0, ['git']))
await allows('git unlocked -> .git/config', () => ws.resolveInside(ROOT, '.git/config', ['git']))
await denies('git unlocked -> .env still shut', () => ws.resolveInside(ROOT, '.env', ['git']))
await denies('git unlocked -> key.pem still shut', () => ws.resolveInside(ROOT, 'key.pem', ['git']))
await denies('git unlocked -> node_modules still shut', () =>
  ws.resolveInside(ROOT, 'node_modules/pkg/index.js', ['git']))
await allows('env unlocked -> .env', () => ws.resolveInside(ROOT, '.env', ['env']))
await allows('deps unlocked -> node_modules', () =>
  ws.resolveInside(ROOT, 'node_modules/pkg/index.js', ['deps']))
await allows('keys unlocked -> key.pem', () => ws.resolveInside(ROOT, 'key.pem', ['keys']))

console.log('\n-- unlocking never widens the jail itself --')
await denies('all unlocked -> ../../etc/passwd', () =>
  ws.resolveInside(ROOT, '../../etc/passwd', ['git', 'deps', 'env', 'keys']))
await denies('all unlocked -> absolute path', () =>
  ws.resolveInside(ROOT, '/etc/passwd', ['git', 'deps', 'env', 'keys']))
await denies('all unlocked -> symlink escape', () =>
  ws.resolveInside(ROOT, 'escape/secret.txt', ['git', 'deps', 'env', 'keys']))

const stillHidden = await ws.listDir(ROOT, '.')
console.log('\nlist_dir still hides locked entries:',
  !stillHidden.includes('.git') && !stillHidden.includes('.env') ? 'ok' : 'FAIL')
const shown = await ws.listDir(ROOT, '.', ['git', 'env'])
console.log('list_dir shows unlocked entries:',
  shown.includes('.git') && shown.includes('.env') ? 'ok' : 'FAIL -- ' + JSON.stringify(shown))

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
