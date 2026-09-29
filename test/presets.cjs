const { app } = require('electron')

app.whenReady().then(() => {
  const { presets: P } = require('../out/test/entry.cjs')
  let pass = 0, fail = 0
  const check = (label, ok, detail = '') => {
    console.log((ok ? 'ok    ' : 'FAIL  ') + label + (ok || !detail ? '' : ' -- ' + detail))
    ok ? pass++ : fail++
  }
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

  console.log('-- applying --')
  const own = { temperature: 0.3, topK: 40, maxTokens: 800, seed: 9, reasoningEffort: 'low' }
  const prose = P.BUILT_IN.find((p) => p.name === 'prose')
  const applied = P.applyPreset(own, prose)
  check('the samplers are replaced wholesale, not merged',
    applied.temperature === 1.05 && applied.topK === undefined && applied.minP === 0.05, JSON.stringify(applied))
  check('the reply limit, seed and reasoning are left alone',
    applied.maxTokens === 800 && applied.seed === 9 && applied.reasoningEffort === 'low')
  check('the result matches the preset', P.matchesPreset(applied, prose))
  check('and no longer matches another', !P.matchesPreset(applied, P.BUILT_IN[0]))
  check('a stray extra sampler breaks the match', !P.matchesPreset({ ...applied, topK: 5 }, prose))
  check('nothing set matches nothing', P.BUILT_IN.every((p) => !P.matchesPreset({}, p)))

  console.log('\n-- saving --')
  const saved = P.savePreset([], 'my preset', { temperature: 0.8, minP: 0.1, maxTokens: 500 })
  check('saved with the samplers only', Array.isArray(saved) && eq(saved[0].params, { temperature: 0.8, minP: 0.1 }), JSON.stringify(saved))
  check('a built-in name is refused', 'error' in P.savePreset([], 'Prose', { temperature: 1 }))
  check('an empty name is refused', 'error' in P.savePreset([], '  ', { temperature: 1 }))
  check('nothing to save is refused', 'error' in P.savePreset([], 'x', { maxTokens: 5 }))
  const replaced = P.savePreset(saved, 'My Preset', { temperature: 0.5 })
  check('the same name replaces rather than duplicates',
    replaced.length === 1 && replaced[0].params.temperature === 0.5 && replaced[0].name === 'My Preset')

  console.log('\n-- round trip --')
  const raw = P.serialisePresets([...P.BUILT_IN, ...saved])
  const back = P.parsePresets(raw)
  check('built-ins are not persisted', back.length === 1 && back[0].name === 'my preset')
  check('garbage parses to nothing', P.parsePresets('{').length === 0 && P.parsePresets('[1,"x",{"name":"","params":{}}]').length === 0)
  check('non-numbers are dropped on the way in',
    eq(P.parsePresets('[{"name":"a","params":{"temperature":"hot","minP":0.1}}]')[0].params, { minP: 0.1 }))

  console.log(`\n${pass} passed, ${fail} failed`)
  app.exit(fail === 0 ? 0 : 1)
}).catch((e) => { console.log('THREW ' + e.stack); app.exit(1) })
