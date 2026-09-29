import { cacheVerdict, cacheLine, MISS_BELOW, MIN_PROMPT, IDLE_MS } from '../out/test/cache.mjs'

let pass = 0, fail = 0
const check = (label, ok, detail = '') => { console.log((ok ? 'ok    ' : 'FAIL  ') + label + (ok || !detail ? '' : ' -- ' + detail)); ok ? pass++ : fail++ }
const reply = (o = {}) => ({ id: 'x', role: 'assistant', model: 'a/m', promptTokens: 10_000, cachedTokens: 9_000, cacheWriteTokens: null, prefixHash: 'p1', trimmed: false, summaryOf: null, error: null, createdAt: 1_000_000, ...o })

console.log('-- the rate --')
check('a cached reply reads as its share', cacheLine(cacheVerdict(reply(), null, [])) === '90% cached')
check('nothing known, nothing said', cacheVerdict(reply({ promptTokens: null }), null, []).rate === null && cacheLine(cacheVerdict(reply({ promptTokens: null }), null, [])) === '')
check('a short prompt is under the cacheable minimum and never a miss', !cacheVerdict(reply({ promptTokens: MIN_PROMPT - 1, cachedTokens: 0 }), reply(), []).missed)
check('a first turn that wrote the cache says so', /First cached turn/.test(cacheVerdict(reply({ cachedTokens: 0, cacheWriteTokens: 8_000 }), null, []).note))
check('a hit after a hit says what was written for next time', /written to the cache/.test(cacheVerdict(reply({ cacheWriteTokens: 500 }), reply(), []).note))
check('the threshold is the constant', cacheVerdict(reply({ cachedTokens: Math.floor(10_000 * MISS_BELOW) }), reply(), []).missed === false && cacheVerdict(reply({ cachedTokens: 10 }), reply(), []).missed === true)

console.log('\n-- why a miss --')
const miss = (o, prev = reply(), between = []) => cacheVerdict(reply({ cachedTokens: 0, createdAt: 1_001_000, ...o }), prev, between)
check('another model', /another model/.test(miss({ model: 'b/n' }).note))
check('compaction between', /compacted/.test(miss({}, reply(), [{ role: 'user', summaryOf: 'leaf', trimmed: false }]).note))
check('trimming between', /trimmed/.test(miss({}, reply(), [{ role: 'tool', summaryOf: null, trimmed: true }]).note))
check('the prefix changed', /instructions or the tool set/.test(miss({ prefixHash: 'p2' }).note))
check('idle too long', /idle/.test(miss({ createdAt: 1_000_000 + IDLE_MS + 1 }).note))
check('otherwise, the provider', /provider served it uncached/.test(miss({}).note))
check('after a reply that was never cached there is no miss to explain', !miss({}, reply({ cachedTokens: 0, cacheWriteTokens: null })).missed)
check('model first, since a different model explains everything else', /another model/.test(miss({ model: 'b/n', prefixHash: 'p2' }).note))

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
