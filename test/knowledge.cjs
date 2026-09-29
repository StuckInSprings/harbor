const { app } = require('electron')
const path = require('path')
const fs = require('fs')

const TMP = '/tmp/harbor-knowledge-test'
fs.rmSync(TMP, { recursive: true, force: true })
fs.mkdirSync(TMP, { recursive: true })
app.setPath('userData', TMP)

// Reuse whatever embedding model is already cached rather than re-downloading
// 128MB for a test run.
const CACHES = [
  path.join(process.env.HOME, 'Library/Application Support/harbor/models'),
  path.join(process.env.HOME, 'Library/Application Support/Electron/models')
]
const cached = CACHES.find((c) => fs.existsSync(c))
if (cached) fs.symlinkSync(cached, path.join(TMP, 'models'))
else console.log('NOTE: no cached model found; this run will download one.')

process.on('unhandledRejection', (e) => {
  fs.appendFileSync('/tmp/knowledge-test.log', 'UNHANDLED: ' + (e && e.stack ? e.stack : e) + '\n')
  app.exit(1)
})

app.whenReady().then(async () => {
  const { db, knowledge: k, embed: E } = require('../out/test/entry.cjs')
  let pass = 0, fail = 0
  const say = (line) => {
    process.stdout.write(line + '\n')
    fs.appendFileSync('/tmp/knowledge-test.log', line + '\n')
  }
  const check = (label, ok, detail = '') => {
    say((ok ? 'ok    ' : 'FAIL  ') + label + (ok || !detail ? '' : ' -- ' + detail))
    ok ? pass++ : fail++
  }

  db.initDb()
  const project = db.createProject('test', null)
  const docs = path.join(__dirname, '..', 'docs')
  const source = db.addSource(project.id, docs)

  check('vector extension loaded', db.hasVectorSearch())

  const t0 = Date.now()
  const result = await k.indexSource(source.id, project.id, docs)
  say(`      indexed ${result.chunks} chunks from ${result.files} files in ${Date.now() - t0}ms`)
  check('indexed some chunks', result.chunks > 10, JSON.stringify(result))

  // Re-index must skip unchanged files rather than duplicating them.
  const again = await k.indexSource(source.id, project.id, docs)
  check('re-index skips unchanged files', again.skipped === again.files && again.chunks === 0,
    JSON.stringify(again))

  say('  (indexing done, searching)')
  const exact = await k.search(project.id, 'sqlite-vec', 5)
  check('exact term retrieves', exact.length > 0 && exact.some(h => h.content.includes('sqlite-vec')),
    JSON.stringify(exact.map(h => h.relPath)))

  /*
    The claim is that the vector half finds a paraphrase sharing no keywords, so
    assert against the vector half rather than the fused list — otherwise an
    unrelated doc gaining the word "keep" fails a test about embeddings.
  */
  const paraQ = 'how does the app decide what to keep in its notebook'
  const [pv] = await E.embed([E.asQuery(paraQ)])
  const vecOnly = db.searchChunksVector(project.id, E.toBuffer(pv), 3).map(r => db.getChunk(r.id))
  // Several documents discuss memory, so assert the subject rather than the
  // filename: the query shares no words with "memory" and must still find it.
  check('vector half retrieves a paraphrase with no shared keywords',
    vecOnly.some(c => /memor/i.test(c.heading + ' ' + c.content)),
    JSON.stringify(vecOnly.map(c => c.relPath + ' :: ' + c.heading)))

  const para = await k.search(project.id, paraQ, 5)
  check('and the fused search returns something for it', para.length > 0)

  const cited = k.formatHits(para.slice(0, 2))
  check('hits are cited with path and heading', /^\[1\] [^\n]+/.test(cited), cited.slice(0, 80))

  const none = await k.search(project.id, 'zzzznonexistentterm', 5)
  check('nonsense term returns nothing', none.length === 0, JSON.stringify(none.map(h => h.relPath)))

  const offTopic = await k.search(project.id, 'recipe for sourdough bread proving overnight', 5)
  check('off-topic question is dropped or flagged weak',
    offTopic.length === 0 || offTopic.every(h => h.weak),
    JSON.stringify(offTopic.map(h => h.relPath)))
  if (offTopic.length > 0) {
    check('weak results warn the model', /may be beside the point/.test(k.formatHits(offTopic)))
  }

  const strong = await k.search(project.id, 'how are checkpoints stored', 5)
  check('a real question is not flagged weak', strong.length > 0 && !strong[0].weak,
    JSON.stringify(strong.map(h => h.relPath)))

  // What distances do the three query kinds actually produce?
  for (const q of [
    'sqlite-vec',
    'how does the app decide what to keep in its notebook',
    'zzzznonexistentterm',
    'recipe for sourdough bread proving overnight'
  ]) {
    const [v] = await E.embed([E.asQuery(q)])
    const rows = db.searchChunksVector(project.id, E.toBuffer(v), 4)
    say(`  dist "${q.slice(0, 42)}" -> ${rows.map((r) => r.distance.toFixed(3)).join(', ')}`)
  }

  say(`\n${pass} passed, ${fail} failed`)
  app.exit(fail === 0 ? 0 : 1)
}).catch((e) => {
  fs.appendFileSync('/tmp/knowledge-test.log', 'THREW: ' + e.stack + '\n')
  app.exit(1)
})
