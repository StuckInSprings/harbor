const { app } = require('electron')

app.whenReady().then(() => {
  const { sidebar: S } = require('../out/test/entry.cjs')
  let pass = 0, fail = 0
  const check = (label, ok, detail = '') => {
    console.log((ok ? 'ok    ' : 'FAIL  ') + label + (ok || !detail ? '' : ' -- ' + detail))
    ok ? pass++ : fail++
  }
  const ids = (rows) => rows.map((r) => r.id).join(',')
  const day = 86_400_000
  const now = new Date(2026, 8, 26, 15, 0).getTime()
  const row = (id, ago, pinned = false) => ({ id, title: id, pinned, archived: false, updatedAt: now - ago })

  console.log('-- what a project shows --')
  const many = Array.from({ length: 12 }, (_, i) => row(`c${i}`, i * 3_600_000))
  const cut = S.shownRows(many, false)
  check('a long project shows the newest few and says how many more', cut.rows.length === S.RECENT && cut.more === 12 - S.RECENT && ids(cut.rows) === 'c0,c1,c2,c3,c4,c5', JSON.stringify(cut))
  check('expanded, it shows them all, newest first', S.shownRows(many, true).rows.length === 12 && S.shownRows(many, true).more === 0)
  check('a short project shows everything and nothing more', S.shownRows(many.slice(0, 4), false).rows.length === 4 && S.shownRows(many.slice(0, 4), false).more === 0)
  const pinned = [row('old-pin', 40 * day, true), ...many]
  const withPin = S.shownRows(pinned, false)
  check('pinned comes first however old it is, and counts toward the limit', withPin.rows[0].id === 'old-pin' && withPin.rows.length === S.RECENT && ids(withPin.rows) === 'old-pin,c0,c1,c2,c3,c4')
  const allPinned = Array.from({ length: 8 }, (_, i) => row(`p${i}`, i * 1000, true)).concat(many)
  const crowded = S.shownRows(allPinned, false)
  check('pins past the limit still leave two recent ones showing', crowded.rows.filter((r) => r.pinned).length === 8 && crowded.rows.filter((r) => !r.pinned).length === 2 && crowded.more === 10)
  check('the input is not reordered', many[0].id === 'c0' && ids(S.shownRows([row('b', 1000), row('a', 0)], true).rows) === 'a,b')

  console.log('\n-- grouped by when --')
  const spread = [row('pin', 100 * day, true), row('now', 0), row('morning', 5 * 3_600_000), row('yday', 1 * day), row('midweek', 3 * day), row('lastweek', 12 * day), row('ages', 90 * day)]
  const groups = S.groupByRecency(spread, now)
  check('the buckets are in order and only those with rows appear', groups.map((g) => g.label).join('|') === 'Pinned|Today|Yesterday|This week|This month|Earlier', groups.map((g) => g.label).join('|'))
  check('each row is where a person would look for it', ids(groups[1].rows) === 'now,morning' && ids(groups[2].rows) === 'yday' && ids(groups[3].rows) === 'midweek' && ids(groups[4].rows) === 'lastweek' && ids(groups[5].rows) === 'ages' && ids(groups[0].rows) === 'pin')
  check('yesterday is by calendar, not by twenty-four hours', S.groupByRecency([row('late-last-night', 16 * 3_600_000)], now)[0].label === 'Yesterday')
  check('nothing groups to nothing', S.groupByRecency([], now).length === 0)

  console.log('\n-- the filter --')
  check('words in any order, any case', S.matchesFilter('A long conversation about the harbour', 'HARBOUR long') && !S.matchesFilter('A long conversation', 'harbour') && S.matchesFilter('anything', '  '))

  console.log('\n-- putting projects in order --')
  const P = ['a', 'b', 'c', 'd']
  check('dropped before another, it goes in front of it', S.moveItem(P, 'd', 'b', 'before').join('') === 'adbc')
  check('dropped after another, behind it', S.moveItem(P, 'a', 'c', 'after').join('') === 'bcad')
  check('dropped on itself, or on nothing known, nothing moves', S.moveItem(P, 'b', 'b', 'after') === P && S.moveItem(P, 'x', 'b', 'before') === P)
  check('a step up or down, and nothing past either end', S.moveBy(P, 'c', -1).join('') === 'acbd' && S.moveBy(P, 'a', -1) === P && S.moveBy(P, 'd', 1) === P)

  console.log(`\n${pass} passed, ${fail} failed`)
  app.exit(fail ? 1 : 0)
}).catch((e) => { console.log('THREW ' + e.stack); app.exit(1) })
