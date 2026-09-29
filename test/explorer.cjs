const { app } = require('electron')
const fs = require('fs')
const path = require('path')

const TMP = '/tmp/harbor-explorer-test'
fs.rmSync(TMP, { recursive: true, force: true })
const root = path.join(TMP, 'root')
fs.mkdirSync(path.join(root, 'src'), { recursive: true })
fs.mkdirSync(path.join(root, 'node_modules', 'x'), { recursive: true })
fs.mkdirSync(path.join(root, '.git'), { recursive: true })
fs.writeFileSync(path.join(root, 'README.md'), '# hi')
fs.writeFileSync(path.join(root, '.env'), 'SECRET=1')
fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export {}')
// A 1x1 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
fs.writeFileSync(path.join(root, 'src', 'pic.png'), PNG)
app.setPath('userData', TMP)

app.whenReady().then(async () => {
  const { files: F, workspace: W } = require('../out/test/entry.cjs')
  let pass = 0, fail = 0
  const check = (label, ok, detail = '') => {
    console.log((ok ? 'ok    ' : 'FAIL  ') + label + (ok || !detail ? '' : ' -- ' + detail))
    ok ? pass++ : fail++
  }

  console.log('-- kinds by extension --')
  check('images', F.isImage('a/b.PNG') && F.isImage('c.webp') && !F.isImage('c.svg'))
  check('mime', F.imageMime('x.jpg') === 'image/jpeg' && F.imageMime('x.txt') === null)
  check('attachable: images, pdf, text', F.isAttachable('a.png') && F.isAttachable('a.pdf') && F.isAttachable('a.md') && !F.isAttachable('a.exe'))
  check('a dotfile has no extension', F.extOf('.env') === '' && F.extOf('dir.v2/file') === '')
  check('parent and join', F.parentOf('a/b/c.png') === 'a/b' && F.parentOf('c.png') === '.' && F.joinPath('.', 'x') === 'x' && F.joinPath('a/', 'x') === 'a/x')
  check('bytes read like sizes', F.formatBytes(512) === '512 B' && F.formatBytes(2048) === '2.0 KB' && F.formatBytes(3 * 1024 * 1024) === '3.0 MB')

  console.log('\n-- the tree hides what the jail hides --')
  const top = await W.tree(root, '.')
  const names = top.map((e) => e.name)
  check('directories first, then files, alphabetical', names.join(' ') === 'src README.md', names.join(' '))
  check('node_modules, .git and .env are not listed', !names.includes('node_modules') && !names.includes('.git') && !names.includes('.env'))
  check('unlocked deps appear', (await W.tree(root, '.', ['deps'])).some((e) => e.name === 'node_modules'))
  const src = await W.tree(root, 'src')
  check('files carry their size', src.find((e) => e.name === 'a.ts').size === 9 && src.find((e) => e.name === 'pic.png').kind === 'file')
  check('a path outside the root is refused', await W.tree(root, '../').then(() => false, () => true))

  console.log('\n-- images --')
  const img = await W.readImage(root, 'src/pic.png')
  check('comes back as base64 with its mime', img.mime === 'image/png' && Buffer.from(img.base64, 'base64').equals(PNG))
  check('a text file is refused as an image', await W.readImage(root, 'README.md').then(() => false, (e) => /not an image/.test(e.message)))
  check('a denied path is refused', await W.readImage(root, 'node_modules/x/a.png').then(() => false, () => true))

  console.log(`\n${pass} passed, ${fail} failed`)
  app.exit(fail === 0 ? 0 : 1)
}).catch((e) => { console.log('THREW ' + e.stack); app.exit(1) })
