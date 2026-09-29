const { app } = require('electron')

app.whenReady().then(() => {
  const { highlightLib: H } = require('../out/test/entry.cjs')
  let pass = 0, fail = 0
  const check = (label, ok, detail = '') => {
    console.log((ok ? 'ok    ' : 'FAIL  ') + label + (ok || !detail ? '' : ' -- ' + detail))
    ok ? pass++ : fail++
  }

  console.log('-- grammars by extension --')
  check('typescript, tsx included', H.languageFor('src/a.tsx') === 'typescript' && H.languageFor('b.ts') === 'typescript')
  check('markdown', H.languageFor('notes.md') === 'markdown')
  check('html is xml to highlight.js', H.languageFor('x.html') === 'xml')
  check('unknown is plain', H.languageFor('a.xyz') === null && H.languageFor('Makefile') === null)
  check('Dockerfile by name', H.languageFor('Dockerfile') === 'dockerfile')

  console.log('\n-- highlighting --')
  const r = H.runs(H.highlight('const x = "hi" // note', 'typescript'))
  const text = r.map((x) => x.text).join('')
  check('the text survives exactly', text === 'const x = "hi" // note', text)
  check('keywords, strings and comments are classed',
    r.some((x) => x.classes.includes('hljs-keyword') && x.text === 'const') &&
    r.some((x) => x.classes.includes('hljs-string')) &&
    r.some((x) => x.classes.includes('hljs-comment')))
  const plain = H.runs(H.highlight('anything at all', null))
  check('plain text is one unclassed run', plain.length === 1 && plain[0].classes.length === 0)
  check('a long file round-trips', (() => { const src = Array.from({ length: 400 }, (_, i) => `let v${i} = ${i}; // c`).join('\n'); return H.runs(H.highlight(src, 'javascript')).map((x) => x.text).join('') === src })())

  console.log(`\n${pass} passed, ${fail} failed`)
  app.exit(fail === 0 ? 0 : 1)
}).catch((e) => { console.log('THREW ' + e.stack); app.exit(1) })
