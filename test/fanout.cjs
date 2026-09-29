const { app } = require('electron')

app.whenReady().then(() => {
  const { fanout: F } = require('../out/test/entry.cjs')
  let pass = 0, fail = 0
  const check = (label, ok, detail = '') => {
    console.log((ok ? 'ok    ' : 'FAIL  ') + label + (ok || !detail ? '' : ' -- ' + detail))
    ok ? pass++ : fail++
  }
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)
  const ids = (list) => list.map((v) => v.model)

  console.log('-- who gets asked --')
  check('the current model leads', eq(ids(F.planFanOut('x/y', ['a/b', 'c/d'])), ['x/y', 'a/b', 'c/d']))
  check('no repeats, even of the current one', eq(ids(F.planFanOut('x/y', ['x/y', 'a/b', 'a/b'])), ['x/y', 'a/b']))
  check('blanks are dropped', eq(ids(F.planFanOut('x/y', ['', '  ', 'a/b '])), ['x/y', 'a/b']))
  check('capped', F.planFanOut('x/y', ['1', '2', '3', '4', '5', '6', '7', '8']).length === F.FAN_OUT_MAX)
  check('an ordinary send is a fan-out of one', eq(ids(F.planFanOut('x/y', [])), ['x/y']))

  console.log('\n-- the same model twice, under other samplers --')
  const twice = F.planFanOut('x/y', [{ model: 'x/y', params: { temperature: 1.4 } }, { model: 'x/y', params: { temperature: 1.4 } }, { model: 'x/y', params: { temperature: 0.3, minP: 0.05 } }])
  check('a variant with samplers is another ask of the same model; the same samplers again are not', twice.length === 3 && twice[0].params === undefined && twice[1].params.temperature === 1.4 && twice[2].params.minP === 0.05, JSON.stringify(twice))
  check('the label names the samplers, short and sorted', F.variantLabel(twice[1]) === 't=1.4' && F.variantLabel(twice[2]) === 'min_p=0.05 t=0.3' && F.variantLabel(twice[0]) === '')
  check('a given label wins, and the key carries it', F.variantLabel({ model: 'm', label: 'hot' }) === 'hot' && F.variantKey({ model: 'm', label: 'hot' }) === 'm hot' && F.variantKey({ model: 'm' }) === 'm')
  check('a layout round-trips through settings, dropping junk', eq(F.parseLayout(JSON.stringify([...twice, { nope: 1 }, 'str', null])), twice) && eq(F.parseLayout('garbage'), []) && eq(F.parseLayout(null), []))
  check('the layout key is per project', F.layoutKey('p1') === 'fanout_layout:p1' && F.layoutKey(null) === 'fanout_layout:general')

  console.log('\n-- the columns --')
  const msg = (id, parentId, role, createdAt, model = null, label = null) => ({ id, parentId, role, createdAt, model, label })
  const all = [
    msg('u', null, 'user', 1),
    msg('r2', 'u', 'assistant', 3, 'b/b'),
    msg('r1', 'u', 'assistant', 2, 'a/a'),
    msg('t', 'r1', 'tool', 4),
    msg('other', 'r1', 'assistant', 5),
    msg('u2', null, 'user', 6),
    msg('r3', 'u', 'assistant', 7, 'a/a', 't=1.4')
  ]
  const cols = F.compareColumns(all, 'u')
  check('assistant replies under the parent, oldest first', eq(cols.map((m) => m.id), ['r1', 'r2', 'r3']))
  check('nothing under a message with no replies', F.compareColumns(all, 'u2').length === 0)

  console.log('\n-- judged blind --')
  const b1 = F.blindOrder(cols, 'u')
  check('the blind order is stable for one parent', eq(b1.map((m) => m.id), F.blindOrder(cols, 'u').map((m) => m.id)) && b1.length === 3)
  // Over many parents the order they were made in must not be what is shown, or blind is not blind.
  const seeds = Array.from({ length: 40 }, (_, i) => `parent-${i}`)
  const same = seeds.filter((s) => eq(F.blindOrder(cols, s).map((m) => m.id), ['r1', 'r2', 'r3'])).length
  check('and is not the order they were asked in', same < 20, `${same} of 40 seeds kept the asked order`)
  check('a reply is rated as its model and variant', F.replyKey(cols[0]) === 'a/a' && F.replyKey(cols[2]) === 'a/a t=1.4' && F.replyKey({ model: null, label: null }) === 'unknown')

  console.log('\n-- the ratings --')
  const t1 = F.applyVote({}, 'a/a', ['b/b'])
  check('two unknowns: the winner up sixteen, the loser down sixteen', t1['a/a'].rating === 1016 && t1['b/b'].rating === 984 && t1['a/a'].games === 1 && t1['b/b'].games === 1, JSON.stringify(t1))
  const t2 = F.applyVote(t1, 'b/b', ['a/a'])
  check('the return match moves more, the odds being against', t2['b/b'].rating > 1000 && t2['b/b'].rating - 984 > 16 && Math.abs(t2['a/a'].rating + t2['b/b'].rating - 2000) < 0.2, JSON.stringify(t2))
  const t3 = F.applyVote({}, 'w', ['l1', 'l2', 'l1', 'w'])
  check('a three-way vote is pairwise, no self-play, no double count', t3.w.rating === 1032 && t3.w.games === 2 && t3.l1.rating === 984 && t3.l1.games === 1 && t3.l2.games === 1, JSON.stringify(t3))
  check('the input table is not changed', Object.keys(t1).length === 2 && t1['a/a'].rating === 1016)
  check('the board is best first', eq(F.leaderboard(t3).map((r) => r.key), ['w', 'l1', 'l2']))
  check('ratings round-trip through settings, dropping junk', eq(F.parseRatings(JSON.stringify({ ...t3, bad: { rating: 'x' }, worse: 3 })), t3) && eq(F.parseRatings('nope'), {}) && eq(F.parseRatings(null), {}))
  check('the ratings key is per project', F.ratingsKey('p1') === 'elo:p1' && F.ratingsKey(null) === 'elo:general')
  check('the expected score is half at even ratings and near one at a big lead', F.expected(1000, 1000) === 0.5 && F.expected(1400, 1000) > 0.9)

  console.log('\n-- a question about a reply --')
  const aside = F.asideMessages('  The reply text.  ', ' Is it consistent? ')
  check('the model sees the reply and the question, and is told to answer the question', aside.length === 2 && aside[0].role === 'system' && /side question/.test(aside[0].content) && aside[1].content === 'The reply:\n\nThe reply text.\n\n---\n\nThe question: Is it consistent?', JSON.stringify(aside))

  console.log(`\n${pass} passed, ${fail} failed`)
  app.exit(fail === 0 ? 0 : 1)
}).catch((e) => { console.log('THREW ' + e.stack); app.exit(1) })
