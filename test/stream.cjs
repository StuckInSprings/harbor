const { app } = require('electron')

app.whenReady().then(() => {
  const { streamLib: S, listNav: L } = require('../out/test/entry.cjs')
  let pass = 0, fail = 0
  const check = (label, ok, detail = '') => {
    console.log((ok ? 'ok    ' : 'FAIL  ') + label + (ok || !detail ? '' : ' -- ' + detail))
    ok ? pass++ : fail++
  }
  const s = (t) => S.splitStable(t)
  console.log('-- where a streaming reply is cut --')
  check('nothing is cut from one paragraph', s('one line of text still coming').stable === '' && s('one line of text still coming').tail === 'one line of text still coming')
  const two = 'first paragraph.\n\nsecond, still coming'
  check('the last paragraph break is the cut', s(two).stable === 'first paragraph.\n\n' && s(two).tail === 'second, still coming')
  const three = 'a\n\nb\n\nc still'
  check('with several breaks, the last one', s(three).stable === 'a\n\nb\n\n' && s(three).tail === 'c still')
  const fence = 'intro\n\n```ts\nconst a = 1\n\nconst b = 2\n'
  check('a break inside an open code fence is not a cut', s(fence).stable === 'intro\n\n' && s(fence).tail.startsWith('```ts'))
  const closed = 'intro\n\n```ts\nconst a = 1\n```\n\nafter, still coming'
  check('once the fence closes the break after it is', s(closed).stable === 'intro\n\n```ts\nconst a = 1\n```\n\n' && s(closed).tail === 'after, still coming')
  check('a trailing blank line is not a cut, since what follows is not there yet', s('para\n\n').stable === '' && s('para\n\n').tail === 'para\n\n')
  check('stable and tail always make the whole', [two, three, fence, closed, 'x', ''].every((t) => s(t).stable + s(t).tail === t))
  console.log('\n-- one way through a list --')
  const n = L.navigateList
  check('the arrows move and clamp', n('ArrowDown', 0, 3) === 1 && n('ArrowDown', 2, 3) === 2 && n('ArrowUp', 1, 3) === 0 && n('ArrowUp', 0, 3) === 0)
  check('home, end and the pages', n('Home', 2, 3) === 0 && n('End', 0, 3) === 2 && n('PageDown', 0, 30) === 10 && n('PageDown', 25, 30) === 29 && n('PageUp', 5, 30) === 0)
  check('other keys are not movement, and an empty list has nowhere to go', n('Enter', 0, 3) === null && n('a', 0, 3) === null && n('ArrowDown', 0, 0) === null)

  console.log(`\n${pass} passed, ${fail} failed`)
  app.exit(fail ? 1 : 0)
}).catch((e) => { console.log('THREW ' + e.stack); app.exit(1) })
