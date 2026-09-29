const { app } = require('electron')

app.whenReady().then(() => {
  const { menus } = require('../out/test/entry.cjs')
  let pass = 0, fail = 0
  const check = (label, ok, detail = '') => {
    console.log((ok ? 'ok    ' : 'FAIL  ') + label + (ok || !detail ? '' : ' -- ' + detail))
    ok ? pass++ : fail++
  }
  const labels = (kind, state) =>
    menus.itemsFor({ kind, state }).map((i) => i.label ?? '--')

  console.log('-- conversation --')
  const fresh = labels('conversation', { pinned: false, archived: false })
  check('offers rename, pin, archive, delete',
    fresh.includes('Rename') && fresh.includes('Pin') && fresh.includes('Archive') &&
    fresh.includes('Delete…'), JSON.stringify(fresh))
  const pinned = labels('conversation', { pinned: true, archived: true })
  check('labels flip with state',
    pinned.includes('Unpin') && pinned.includes('Move back to the sidebar'),
    JSON.stringify(pinned))

  console.log('\n-- a selection --')
  const three = labels('selection', { count: 3, anyArchived: false })
  check('group actions carry the count', three.includes('Archive 3 conversations') && three.includes('Delete 3 conversations…') && three.includes('Clear selection'), JSON.stringify(three))
  check('one is singular', labels('selection', { count: 1 }).includes('Delete 1 conversation…'))
  const back = menus.itemsFor({ kind: 'selection', state: { count: 2, anyArchived: true } }).find((i) => i.id === 'unarchive')
  const hidden = menus.itemsFor({ kind: 'selection', state: { count: 2, anyArchived: false } }).find((i) => i.id === 'unarchive')
  check('moving back is offered only when something selected is archived', back.visible === true && hidden.visible === false)

  console.log('\n-- project --')
  const onlyOne = menus.itemsFor({ kind: 'project', state: { deletable: false } })
  const del = onlyOne.find((i) => i.id === 'delete')
  check('cannot delete the last project', del.enabled === false)
  const many = menus.itemsFor({ kind: 'project', state: { deletable: true } })
  check('can delete when others exist', many.find((i) => i.id === 'delete').enabled === true)
  const showing = labels('project', { showingArchived: true })
  check('archive toggle reflects state', showing.includes('Hide archived'), JSON.stringify(showing))

  console.log('\n-- message --')
  const asst = labels('message', { role: 'assistant' })
  check('assistant offers retry and remember',
    asst.includes('Retry') && asst.includes('Remember this') && !asst.includes('Edit and fork'),
    JSON.stringify(asst))
  const user = labels('message', { role: 'user' })
  check('user offers edit, not retry',
    user.includes('Edit and fork') && !user.includes('Retry'), JSON.stringify(user))

  console.log('\n-- destructive actions confirm --')
  check('every delete is labelled with an ellipsis or confirms',
    labels('conversation', {}).includes('Delete…') &&
    labels('project', { deletable: true }).includes('Delete project…'))

  console.log(`\n${pass} passed, ${fail} failed`)
  app.exit(fail === 0 ? 0 : 1)
}).catch((e) => { console.log('THREW ' + e.stack); app.exit(1) })
