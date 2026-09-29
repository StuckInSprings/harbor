const { app } = require('electron')

app.whenReady().then(async () => {
  const { launcher: L } = require('../out/test/entry.cjs')
  let pass = 0, fail = 0
  const check = (label, ok, detail = '') => {
    console.log((ok ? 'ok    ' : 'FAIL  ') + label + (ok || !detail ? '' : ' -- ' + detail))
    ok ? pass++ : fail++
  }

  console.log('-- matching --')
  check('a prefix beats a word start beats a substring beats a subsequence',
    L.matchScore('saf', 'Safari') > L.matchScore('stu', 'Visual Studio Code') &&
    L.matchScore('stu', 'Visual Studio Code') > L.matchScore('ual', 'Visual Studio Code') &&
    L.matchScore('ual', 'Visual Studio Code') > L.matchScore('vsc', 'Visual Studio Code') &&
    L.matchScore('vsc', 'Visual Studio Code') > 0)
  check('no fit is zero, and case does not matter', L.matchScore('xyz', 'Safari') === 0 && L.matchScore('SAF', 'safari') === 100)
  check('an empty query fits everything', L.matchScore('', 'Anything') === 1)

  console.log('-- frecency --')
  const now = Date.now()
  check('unused is zero', L.frecency(undefined, now) === 0)
  check('picked today counts in full', L.frecency({ count: 4, last: now }, now) === 4)
  check('two weeks halves it', Math.abs(L.frecency({ count: 4, last: now - 14 * 86_400_000 }, now) - 2) < 1e-9)

  console.log('-- ranking --')
  const apps = [
    { path: '/a/Slack.app', name: 'Slack' },
    { path: '/a/Safari.app', name: 'Safari' },
    { path: '/a/Sublime Text.app', name: 'Sublime Text' }
  ]
  check('ties go alphabetical', L.rank('s', apps, {}, now).map((e) => e.name).join(',') === 'Safari,Slack,Sublime Text')
  check('a favourite rises', L.rank('s', apps, { '/a/Slack.app': { count: 5, last: now } }, now)[0].name === 'Slack')
  check('history cannot lift what does not match', L.rank('saf', apps, { '/a/Slack.app': { count: 50, last: now } }, now).map((e) => e.name).join(',') === 'Safari')
  check('an empty query lists by history then name', L.rank('', apps, { '/a/Sublime Text.app': { count: 1, last: now } }, now)[0].name === 'Sublime Text')

  console.log('-- apps that come first --')
  const favs = ['Harbor', 'Claude', 'Zen', 'iA Writer', 'Visual Studio Code', 'Sublime Text', 'Discord']
  const desktop = [
    { path: '/a/Harbor.app', name: 'Harbor' },
    { path: '/a/Hammerspoon.app', name: 'Hammerspoon' },
    { path: '/a/Claude.app', name: 'Claude' },
    { path: '/a/Calendar.app', name: 'Calendar' },
    { path: '/a/Zen.app', name: 'Zen' },
    { path: '/a/Visual Studio Code.app', name: 'Visual Studio Code' },
    { path: '/a/Sublime Text.app', name: 'Sublime Text' },
    { path: '/a/Discord.app', name: 'Discord' },
    { path: '/a/iA Writer.app', name: 'iA Writer' },
    { path: '/a/Console.app', name: 'Console' }
  ]
  const first = (q, uses = {}) => L.rank(q, desktop, uses, now, favs)[0].name
  check('a bare letter lands on the named favourite', first('h') === 'Harbor' && first('c') === 'Claude' && first('z') === 'Zen' && first('i') === 'iA Writer' && first('d') === 'Discord')
  check('typing on keeps it there', first('ha') === 'Harbor' && first('har') === 'Harbor' && first('cl') === 'Claude' && first('sub') === 'Sublime Text')
  check('co goes to Visual Studio Code, since Claude never matched it', first('co') === 'Visual Studio Code')
  check('a favourite the query does not fit stays out of the way', first('cal') === 'Calendar' && first('con') === 'Console')
  check('standing beats use, and with ranking by use off, use only orders the rest', first('h', { '/a/Hammerspoon.app': { count: 40, last: now } }) === 'Harbor' &&
    L.rank('c', desktop, { '/a/Console.app': { count: 9, last: now } }, now, favs, 'off').map((e) => e.name).slice(0, 4).join(',') === 'Claude,Visual Studio Code,Console,Calendar')
  check('the whole name beats a prefix of a longer one', L.matchScore('zen', 'Zen') > L.matchScore('zen', 'Zen Browser') && L.rank('zen', [{ path: '/a/Zen Browser.app', name: 'Zen Browser' }, { path: '/b/Zen.app', name: 'Zen' }], {}, now)[0].name === 'Zen')

  console.log('-- ranking by use --')
  const heavy = { '/a/Console.app': { count: 9, last: now } }
  check('off, use never lifts past a better fit', L.rank('c', desktop, heavy, now, favs, 'off').map((e) => e.name).slice(0, 3).join(',') === 'Claude,Visual Studio Code,Console')
  check('at medium, an app opened often climbs past a favourite that fits worse, never past one that fits as well',
    L.rank('c', desktop, heavy, now, favs, 'medium').map((e) => e.name).slice(0, 3).join(',') === 'Claude,Console,Visual Studio Code')
  check('and never past a favourite that fits as well, even at high', L.rank('h', desktop, { '/a/Hammerspoon.app': { count: 400, last: now } }, now, favs, 'high')[0].name === 'Harbor')
  check('the lift is capped per level and grows with picks', L.useLift(1, 'low') === 3 && L.useLift(10, 'low') === 6 && L.useLift(10, 'medium') === 12 && L.useLift(10, 'high') === 24 && L.useLift(10, 'off') === 0)
  check('an unknown level reads as the default', L.asSensitivity('nope') === L.DEFAULT_SENSITIVITY && L.asSensitivity(null) === 'medium' && L.asSensitivity('high') === 'high')
  check('with nothing typed, the favourites lead and use orders the rest, at any level', L.rank('', desktop, heavy, now, favs, 'high')[0].name === 'Harbor' && L.rank('', desktop, heavy, now, [], 'high')[0].name === 'Console')

  console.log('-- the index from spotlight --')
  const home = '/Users/example'
  const keep = (p) => L.keepFromSpotlight(p, home)
  check('the application folders and the system\'s own are kept', keep('/Applications/Zen.app') && keep('/Applications/Utilities/Terminal.app') && keep('/System/Applications/Mail.app') && keep('/System/Library/CoreServices/Finder.app') && keep('/System/Library/CoreServices/Applications/Keychain Access.app') && keep(home + '/Applications/Chrome Apps.localized/Docs.app'))
  check('helpers inside another bundle, frameworks and package caches are not', !keep('/System/Library/CoreServices/Finder.app/Contents/Applications/AirDrop.app') && !keep('/System/Library/PrivateFrameworks/AOSKit.framework/Versions/A/Helpers/AOSAlertManager.app') && !keep(home + '/anaconda3/pkgs/qt-main/bin/Assistant.app') && !keep(home + '/anaconda3/bin/python.app') && !keep('/Applications/Xcode.app/Contents/Developer/Applications/Simulator.app'))
  check('nor library, profile and support folders', !keep('/Library/Application Support/Adobe/Uninstall/Uninstaller.app') && !keep(home + '/Library/Application Support/zen/Profiles/x/storage/default/thing.app') && !keep('/System/Library/Input Methods/Kotoeri.app') && !keep('/opt/homebrew/Caskroom/zen/1.0/Zen.app') && !keep('/private/tmp/x.app') && !keep('/Volumes/Installer/App.app'))
  check('a bundle kept under the home folder is', keep(home + '/Downloads/Tool.app') && keep(home + '/Repos/thing/dist/mac-arm64/Harbor.app') && !keep(home + '/Repos/thing/node_modules/electron/dist/Electron.app'))
  check('only bundles', !keep('/Applications/notes.txt') && !keep(''))

  console.log('-- Harbor\'s own entries --')
  check('@ is a project or conversation', L.atQuery('@har') === 'har' && L.atQuery('  @') === '' && L.atQuery('har') === null)
  check('a question is one marked as such, or long with a space, or ending in a question mark', L.askQuery('?zen') === 'zen' && L.askQuery('?') === null && L.askQuery('what is a monad') === 'what is a monad' && L.askQuery('zen') === null && L.askQuery('why?') === 'why?' && L.askQuery('ab') === null && L.askQuery('a b') === 'a b')
  check('a forced question goes first', L.forcedAsk('? what') && !L.forcedAsk('what is'))
  check('asked with a clip, the clip is quoted under the question', L.askWithClip(' summarise ', 'line one\nline two\n') === 'summarise\n\n```\nline one\nline two\n```')
  check('Harbor entries are told from apps, and the clipboard is neither', L.isHarborEntry(L.ASK_ENTRY) && L.isHarborEntry(L.HARBOR_PROJECT + 'x') && !L.isHarborEntry('/Applications/Zen.app') && !L.isHarborEntry(L.CLIPBOARD_ENTRY))
  check('with no favourites set, nothing changes', L.rank('s', apps, {}, now, []).map((e) => e.name).join(',') === 'Safari,Slack,Sublime Text')
  check('the list is read one name per line, blanks dropped', L.parseFavourites('Harbor\n\n Claude \n').join('|') === 'Harbor|Claude' && L.parseFavourites(null).length === 0)

  console.log('-- clipboard history --')
  let h = []
  h = L.pushClip(h, 'one', 1, 1); h = L.pushClip(h, 'two', 2, 2); h = L.pushClip(h, 'one', 3, 3)
  check('a repeat moves up rather than appearing twice', h.map((c) => c.text).join(',') === 'one,two' && h[0].at === 3)
  check('the same text twice in a row is one clip, and blank is none', L.pushClip(h, 'one', 9, 9) === h && L.pushClip(h, '   ', 9, 9) === h)
  let many = []
  for (let i = 0; i < 14; i++) many = L.pushClip(many, 'clip ' + i, i, i)
  check('ten are kept, newest first', many.length === 10 && many[0].text === 'clip 13' && many[9].text === 'clip 4')
  check('a preview is the first line with something in it, flattened and cut', L.clipPreview('\n\n  hello   world \nsecond') === 'hello world' && L.clipPreview('x'.repeat(200)).length === 96 && L.clipPreview('x'.repeat(200)).endsWith('…'))
  check('age reads in the largest sensible unit', L.ago(0, 30_000) === 'just now' && L.ago(0, 5 * 60_000) === '5 min' && L.ago(0, 3 * 3_600_000) === '3 h' && L.ago(0, 49 * 3_600_000) === '2 d')

  console.log(`\n${pass} passed, ${fail} failed`)
  app.exit(fail ? 1 : 0)
})
