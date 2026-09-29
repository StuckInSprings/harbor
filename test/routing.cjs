const { app } = require('electron')

app.whenReady().then(() => {
  const { routing: R } = require('../out/test/entry.cjs')
  let pass = 0, fail = 0
  const check = (label, ok, detail = '') => {
    console.log((ok ? 'ok    ' : 'FAIL  ') + label + (ok || !detail ? '' : ' -- ' + detail))
    ok ? pass++ : fail++
  }
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

  console.log('-- the default sends nothing --')
  check('no fields for the default routing', eq(R.routingFor(R.DEFAULT_ROUTING, 'x/y'), {}))
  check('a missing setting is the default', eq(R.parseRouting(null), R.DEFAULT_ROUTING))
  check('a corrupt setting is the default, not a crash',
    eq(R.parseRouting('{not json'), R.DEFAULT_ROUTING))
  check('a wrong type falls back field by field',
    eq(R.parseRouting('{"sort":"fastest","fallbacks":"nope","denyDataCollection":"yes"}'),
      R.DEFAULT_ROUTING))

  console.log('\n-- the privacy preference goes on the wire --')
  const deny = R.routingFor({ ...R.DEFAULT_ROUTING, denyDataCollection: true }, 'x/y')
  check('data_collection deny', eq(deny, { provider: { data_collection: 'deny' } }),
    JSON.stringify(deny))
  const sorted = R.routingFor({ ...R.DEFAULT_ROUTING, sort: 'price' }, 'x/y')
  check('sort by price', eq(sorted, { provider: { sort: 'price' } }), JSON.stringify(sorted))

  console.log('\n-- fallbacks lead with the chosen model --')
  const fb = R.routingFor({ ...R.DEFAULT_ROUTING, fallbacks: ['a/b', 'c/d'] }, 'x/y')
  check('models list starts with the primary', eq(fb.models, ['x/y', 'a/b', 'c/d']),
    JSON.stringify(fb))
  check('no provider block when nothing else is set', !('provider' in fb))
  const self = R.routingFor({ ...R.DEFAULT_ROUTING, fallbacks: ['x/y'] }, 'x/y')
  check('the chosen model is never its own fallback', !('models' in self), JSON.stringify(self))

  console.log('\n-- the textarea is forgiving --')
  check('lines and commas both split',
    eq(R.parseFallbacks('a/b\nc/d, e/f'), ['a/b', 'c/d', 'e/f']))
  check('blanks and repeats are dropped, order kept',
    eq(R.parseFallbacks('\n a/b \n\na/b\nc/d'), ['a/b', 'c/d']))

  console.log('\n-- what is saved is what is read back --')
  const r = { denyDataCollection: true, sort: 'latency', fallbacks: ['a/b'], ignore: [] }
  check('round trip', eq(R.parseRouting(R.serialiseRouting(r)), r))

    console.log('\n-- providers to avoid --')
  const blocked = R.withIgnored(R.DEFAULT_ROUTING, 'StreamLake')
  check('a provider is added once, whatever its case', blocked.ignore.length === 1 && R.withIgnored(blocked, 'streamlake') === blocked && R.withIgnored(blocked, ' ') === blocked)
  check('and goes on the wire as provider.ignore', eq(R.routingFor(blocked, 'x/y'), { provider: { ignore: ['StreamLake'] } }))
  check('the list survives a round trip and junk is dropped', R.parseRouting(R.serialiseRouting(blocked)).ignore[0] === 'StreamLake' && R.parseRouting('{"ignore":[3,"",  "A"]}').ignore.join() === 'A')

console.log(`\n${pass} passed, ${fail} failed`)
  app.exit(fail === 0 ? 0 : 1)
}).catch((e) => { console.log('THREW ' + e.stack); app.exit(1) })
