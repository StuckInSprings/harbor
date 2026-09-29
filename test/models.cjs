const { app } = require('electron')

app.whenReady().then(() => {
  const { models: M } = require('../out/test/entry.cjs')
  let pass = 0, fail = 0
  const check = (label, ok, detail = '') => {
    console.log((ok ? 'ok    ' : 'FAIL  ') + label + (ok || !detail ? '' : ' -- ' + detail))
    ok ? pass++ : fail++
  }
  const model = (over = {}) => ({
    id: 'x/y', name: 'Y', contextLength: 128000, maxCompletionTokens: 8192,
    promptPrice: 1, completionPrice: 2, cacheReadPrice: null, cacheWritePrice: null,
    tiers: [], inputModalities: ['text'], caching: 'none',
    supportsTools: false, supportsReasoning: false, supportedParameters: [],
    description: '', ...over
  })
  const labels = (m) => M.capabilitiesOf(m).map((c) => c.label)

  console.log('-- the question the picker has to answer --')
  check('a vision model says so',
    labels(model({ inputModalities: ['text', 'image'] })).includes('images'))
  check('a text-only model does not',
    !labels(model()).includes('images'))
  check('and readsImages agrees with the badge',
    M.readsImages(model({ inputModalities: ['text', 'image'] })) === true &&
    M.readsImages(model()) === false)

  console.log('\n-- every capability, in a fixed order --')
  const all = model({
    inputModalities: ['text', 'image', 'file', 'audio', 'video'],
    supportsTools: true, supportsReasoning: true
  })
  check('order is stable down the list',
    labels(all).join(' ') === 'images files audio video tools thinks',
    labels(all).join(' '))
  check('text alone earns no badge', labels(model()).length === 0)
  check('reasoning is named for what it does',
    labels(model({ supportsReasoning: true })).join('') === 'thinks')

  console.log('\n-- the files badge does not lie about PDFs --')
  const filesTitle = M.capabilitiesOf(model({ inputModalities: ['file'] }))[0].title
  check('it says PDFs work anyway', filesTitle.includes('PDFs work on any model'), filesTitle)

  console.log('\n-- the knobs a model honours --')
  const knobs = M.knobsOf(model({
    supportedParameters: ['temperature', 'top_p', 'max_tokens', 'tools', 'reasoning', 'seed']
  }))
  check('named in plain words', knobs.join(', ') === 'temperature, top p, reply limit, seed',
    knobs.join(', '))
  check('tools and reasoning are badges, not knobs',
    !knobs.includes('tools') && !knobs.includes('reasoning'))
  check('an unknown parameter is left out rather than shown raw',
    M.knobsOf(model({ supportedParameters: ['verbosity_9000'] })).length === 0)
  check('nothing supported is an empty list, not a crash',
    Array.isArray(M.knobsOf(model())) && M.knobsOf(model()).length === 0)

  console.log('\n-- the description is cut to the part that says something --')
  const long = 'A fast model for chat. ' + 'It is the best ever. '.repeat(40)
  check('cut at a sentence, not mid-word',
    M.summarise(long).endsWith('.') && M.summarise(long).length <= 240,
    M.summarise(long))
  check('a short one is left alone', M.summarise('Small and quick.') === 'Small and quick.')
  check('no description is no text', M.summarise('') === '')
  check('a single run-on sentence is still truncated',
    M.summarise('word '.repeat(200)).endsWith('…'))
  check('newlines are flattened', !M.summarise('one\n\ntwo').includes('\n'))

  console.log(`\n${pass} passed, ${fail} failed`)
  app.exit(fail === 0 ? 0 : 1)
}).catch((e) => { console.log('THREW ' + e.stack); app.exit(1) })
