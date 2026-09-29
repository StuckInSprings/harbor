const { app } = require('electron')
const path = require('path')
const fs = require('fs')

const TMP = '/tmp/harbor-files-test'
fs.rmSync(TMP, { recursive: true, force: true })
fs.mkdirSync(path.join(TMP, 'corpus'), { recursive: true })
app.setPath('userData', TMP)

const CACHES = [
  path.join(process.env.HOME, 'Library/Application Support/harbor/models'),
  path.join(process.env.HOME, 'Library/Application Support/Electron/models')
]
const cached = CACHES.find((c) => fs.existsSync(c))
if (cached) fs.symlinkSync(cached, path.join(TMP, 'models'))

// A 1x1 PNG, enough to exercise the image path.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)

app.whenReady().then(async () => {
  const { attachments: A, knowledge: K, db } = require('../out/test/entry.cjs')
  let pass = 0, fail = 0
  const check = (label, ok, detail = '') => {
    console.log((ok ? 'ok    ' : 'FAIL  ') + label + (ok || !detail ? '' : ' -- ' + detail))
    ok ? pass++ : fail++
  }

  const png = path.join(TMP, 'dot.png')
  const txt = path.join(TMP, 'notes.txt')
  const pdf = path.join(TMP, 'corpus', 'paper.pdf')
  fs.writeFileSync(png, PNG)
  fs.writeFileSync(txt, 'the sounding line measures depth in fathoms')
  // A real PDF with a text layer. Cached so the suite does not refetch it.
  const SAMPLE = '/tmp/harbor-sample.pdf'
  if (!fs.existsSync(SAMPLE)) {
    const res = await fetch('https://bitcoin.org/bitcoin.pdf')
    fs.writeFileSync(SAMPLE, Buffer.from(await res.arrayBuffer()))
  }
  fs.copyFileSync(SAMPLE, pdf)

  console.log('-- attachment ingestion --')
  const aPng = await A.ingest(png)
  check('png classified as image', aPng.kind === 'image' && aPng.mime === 'image/png', JSON.stringify(aPng))
  const aPdf = await A.ingest(pdf)
  check('pdf classified as pdf', aPdf.kind === 'pdf')
  const aTxt = await A.ingest(txt)
  check('txt classified as text', aTxt.kind === 'text')
  try {
    await A.ingest(path.join(TMP, 'nope.xyz'))
    check('unknown type refused', false)
  } catch {
    check('unknown type refused', true)
  }

  console.log('\n-- pasted and dropped bytes (no path on disk) --')
  const pasted = await A.ingestBytes('Pasted 2026-09-08.png', 'image/png', PNG)
  check('png bytes classified by mime', pasted.kind === 'image' && pasted.size === PNG.length,
    JSON.stringify(pasted))
  check('pasted bytes reach the same blob as the same file on disk',
    pasted.hash === aPng.hash, `${pasted.hash.slice(0,8)} vs ${aPng.hash.slice(0,8)}`)

  const pastedText = await A.ingestBytes('note.txt', 'text/plain', Buffer.from('hello'))
  check('text bytes classified by mime', pastedText.kind === 'text')

  try {
    await A.ingestBytes('thing.bin', 'application/octet-stream', Buffer.from('x'))
    check('unknown mime refused', false)
  } catch (e) {
    check('unknown mime refused with a reason', /cannot attach/.test(e.message), e.message)
  }
  try {
    await A.ingestBytes('huge.png', 'image/png', Buffer.alloc(9 * 1024 * 1024))
    check('oversized paste refused', false)
  } catch (e) {
    check('oversized paste refused with a size', /8MB/.test(e.message), e.message)
  }

  console.log('\n-- content parts match OpenRouter shapes --')
  const pPng = await A.toContentPart(aPng)
  check('image -> image_url data URL',
    pPng.type === 'image_url' && pPng.image_url.url.startsWith('data:image/png;base64,'),
    JSON.stringify(pPng).slice(0, 70))
  const pPdf = await A.toContentPart(aPdf)
  check('pdf -> file part with filename',
    pPdf.type === 'file' && pPdf.file.filename === 'paper.pdf' &&
      pPdf.file.file_data.startsWith('data:application/pdf;base64,'))
  const pTxt = await A.toContentPart(aTxt)
  check('text -> inlined text part',
    pTxt.type === 'text' && pTxt.text.includes('sounding line'))
  check('pdf needs the file-parser plugin', A.needsFileParser([aPdf]) && !A.needsFileParser([aTxt]))
  check('image needs a vision model', A.needsVision([aPng]) && !A.needsVision([aPdf]))

  console.log('\n-- pdf enters the knowledge corpus --')
  db.initDb()
  const project = db.createProject('files', null)
  const source = db.addSource(project.id, path.join(TMP, 'corpus'))
  const res = await K.indexSource(source.id, project.id, path.join(TMP, 'corpus'))
  check('pdf text extracted and chunked', res.chunks > 5, JSON.stringify(res))

  const hits = await K.search(project.id, 'peer-to-peer electronic cash', 5)
  check('retrieves from the pdf', hits.length > 0 && hits.some(h => h.relPath.endsWith('.pdf')),
    JSON.stringify(hits.map(h => h.relPath)))

  console.log(`\n${pass} passed, ${fail} failed`)
  app.exit(fail === 0 ? 0 : 1)
}).catch((e) => {
  console.log('THREW: ' + e.stack)
  app.exit(1)
})
