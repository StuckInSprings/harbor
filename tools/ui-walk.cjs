/*
  A headless walk through Harbor's screens: the real app (out/main) under a
  home of its own, seeded through the preload API, rendered in an offscreen
  window, and every state captured to out/ui-walk/NN-name.png with a
  metrics file beside them. A fake model server answers the turns, so
  nothing is spent and nothing touches the installed app's data.

    npm run build && npx electron tools/ui-walk.cjs

  Run it again after a change to see every screen as it now is.
*/
const path = require('path')
const fs = require('fs')
const http = require('http')
const { app, BrowserWindow, nativeTheme } = require('electron')

const ROOT = path.resolve(__dirname, '..')
const OUT = path.join(ROOT, 'out', 'ui-walk')
const HOME = path.join(ROOT, 'out', 'ui-walk-home')
const PROJ = path.join(HOME, 'project')
fs.rmSync(OUT, { recursive: true, force: true })
fs.rmSync(HOME, { recursive: true, force: true })
fs.mkdirSync(OUT, { recursive: true })
fs.mkdirSync(path.join(PROJ, 'src', 'deep', 'deeper'), { recursive: true })
fs.mkdirSync(path.join(HOME, 'userData'), { recursive: true })
fs.writeFileSync(path.join(PROJ, 'README.md'), '# Audit project\n\nA fixture for the UI walk.\n\n- one\n- two\n')
fs.writeFileSync(path.join(PROJ, 'src', 'index.ts'), Array.from({ length: 300 }, (_, i) => `export const line${i} = ${i} // ${'x'.repeat(i % 90)}`).join('\n'))
fs.writeFileSync(path.join(PROJ, 'src', 'deep', 'deeper', 'nested-file-with-a-very-long-name-to-see-truncation.ts'), 'export {}\n')
for (let i = 0; i < 45; i++) fs.writeFileSync(path.join(PROJ, 'src', `module-${String(i).padStart(2, '0')}.ts`), `export const m${i} = ${i}\n`)
app.setPath('userData', path.join(HOME, 'userData'))

const metrics = { steps: [], notes: [] }
const note = (k, v) => { metrics.notes.push({ k, v }); console.log('note', k, typeof v === 'string' ? v.slice(0, 200) : JSON.stringify(v).slice(0, 300)) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ---- the fake model server: streams what the last user line asks for ---- */
const MD = '## A heading\n\nSome **bold** and *italic* text with a [link](https://example.com) and `inline code`.\n\n- one\n- two\n- three\n\n| col a | col b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n\n```ts\nexport function hello(name: string): string {\n  return `hi ${name}`\n}\n```\n\nA closing paragraph that runs on for a while so the wrapping of a long line of prose can be seen against the width of the column it sits in.'
const server = http.createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => (raw += c))
  req.on('end', async () => {
    if (req.url.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'audit' }] }))
      return
    }
    if (!req.url.endsWith('/chat/completions')) {
      res.writeHead(404).end()
      return
    }
    const body = JSON.parse(raw)
    const lastUser = [...body.messages].reverse().find((m) => m.role === 'user')
    const hasTool = body.messages.some((m) => m.role === 'tool')
    // Harbor folds consecutive user turns into one; the request is the last line.
    const ask = (typeof lastUser?.content === 'string' ? lastUser.content : JSON.stringify(lastUser?.content || '')).trim().split('\n').pop() || ''
    if (ask.includes('FAIL')) {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'The fake provider fell over on purpose.' } }))
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const chunk = (delta, finish = null, extra = {}) => res.write(`data: ${JSON.stringify({ id: 'x', model: body.model, choices: [{ delta, finish_reason: finish }], ...extra })}\n\n`)
    if (ask.includes('TOOL') && !hasTool) {
      chunk({ role: 'assistant', content: '' })
      chunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'notes/audit.md', content: '# Notes\n\nWritten by the fake model.\n' }) } }] })
      chunk({}, 'tool_calls', { usage: { prompt_tokens: 120, completion_tokens: 30 } })
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }
    const text = hasTool ? 'Done: notes/audit.md is written.' : MD
    const words = text.split(/(?<=\s)/)
    const slow = ask.includes('SLOW')
    chunk({ role: 'assistant', content: '' })
    for (const w of words) {
      chunk({ content: w })
      if (slow) await sleep(90)
    }
    chunk({}, 'stop', { usage: { prompt_tokens: 240, completion_tokens: words.length } })
    res.write('data: [DONE]\n\n')
    res.end()
  })
})

require(path.join(ROOT, 'out/main/index.js'))
// The app points userData at its own folder as it loads; the walk keeps its throwaway home.
app.setPath('userData', path.join(HOME, 'userData'))

app.whenReady().then(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}/v1`
  await sleep(2500)
  const appWin = BrowserWindow.getAllWindows().find((w) => w.getSize()[0] >= 1000)
  if (!appWin) throw new Error('no main window')
  appWin.hide()
  appWin.on('show', () => appWin.hide())
  /*
    A hidden window is never painted, so the walk uses an offscreen window
    of its own: the same renderer and preload, talking to the same main
    process, rendered to a bitmap that capturePage can read.
  */
  const offscreen = (file, w, h) => {
    const b = new BrowserWindow({ show: false, width: w, height: h, webPreferences: { preload: path.join(ROOT, 'out/preload/index.js'), contextIsolation: true, nodeIntegration: false, sandbox: false, offscreen: true } })
    b.webContents.setFrameRate(30)
    b.loadFile(path.join(ROOT, 'out/renderer', file))
    return b
  }
  const win = offscreen('index.html', 1440, 900)
  const wc = win.webContents
  // The renderer's own errors, or a screen that failed to render would only show as a missing element.
  wc.on('console-message', (event) => { if (event.level === 'error' || event.level === 'warning') console.log('renderer', event.level, String(event.message).slice(0, 400)) })
  const ev = (code) => wc.executeJavaScript(`(async () => { ${code} })()`, true)
  const helpers = `
    window.__aud = {
      all(sel) { return [...document.querySelectorAll(sel)] },
      byText(text, sel = 'button, [role=button], .row, .rowitem, li, a, span, div') {
        const list = [...document.querySelectorAll(sel)].filter((e) => e.textContent.trim() === text)
        return list.sort((a, b) => a.querySelectorAll('*').length - b.querySelectorAll('*').length)[0] || null
      },
      byTitle(part) { return [...document.querySelectorAll('[title]')].find((e) => (e.getAttribute('title') || '').toLowerCase().includes(part.toLowerCase())) || null },
      click(el) { if (!el) return false; el.scrollIntoView({ block: 'center' }); el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); el.dispatchEvent(new MouseEvent('click', { bubbles: true })); return true },
      setInput(el, value) { if (el && el.classList && el.classList.contains('composer__input--rich')) { window.__composerEditor.commands.setContent(value, { contentType: 'markdown', emitUpdate: true }); return true } const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })); return true },
      focusPath() { const a = document.activeElement; if (!a || a === document.body) return 'body'; const cls = a.className && typeof a.className === 'string' ? '.' + a.className.trim().split(/\\s+/).join('.') : ''; const t = a.getAttribute('title') || a.getAttribute('aria-label') || ''; const txt = a.tagName === 'BUTTON' ? a.textContent.trim().slice(0, 30) : ''; return a.tagName.toLowerCase() + cls + (t ? ' [' + t + ']' : '') + (txt ? ' "' + txt + '"' : '') },
      scroller() { return [...document.querySelectorAll('*')].filter((e) => e.scrollHeight > e.clientHeight + 40 && /auto|scroll/.test(getComputedStyle(e).overflowY)).sort((a, b) => b.scrollHeight - a.scrollHeight)[0] || null },
      a11y() {
        const buttons = [...document.querySelectorAll('button')]
        const unnamed = buttons.filter((b) => !b.textContent.trim() && !b.getAttribute('aria-label') && !b.querySelector('img[alt]:not([alt=""])'))
        const titleOnly = unnamed.filter((b) => b.getAttribute('title'))
        const clickyDivs = [...document.querySelectorAll('div[onclick], span[onclick]')].length
        return { buttons: buttons.length, unnamed: unnamed.length, titleOnly: titleOnly.length, unnamedSamples: unnamed.slice(0, 8).map((b) => b.className + (b.title ? ' [' + b.title + ']' : '')), roles: document.querySelectorAll('[role]').length, live: document.querySelectorAll('[aria-live]').length, dialogs: document.querySelectorAll('[role=dialog], [aria-modal]').length, nodes: document.querySelectorAll('*').length, clickyDivs }
      }
    }
    return true
  `
  const ready = async () => {
    for (let i = 0; i < 60; i++) {
      const ok = await wc.executeJavaScript('!!document.querySelector(".shell, .gate, .empty")').catch(() => false)
      if (ok) break
      await sleep(250)
    }
    await ev(helpers)
  }
  const shot = async (name, extra) => {
    await sleep(250)
    const img = await wc.capturePage()
    fs.writeFileSync(path.join(OUT, `${name}.png`), img.toPNG())
    const a11y = await ev('return window.__aud.a11y()').catch((e) => ({ error: e.message }))
    const focus = await ev('return window.__aud.focusPath()').catch(() => '?')
    metrics.steps.push({ name, size: img.getSize(), focus, a11y, ...(extra || {}) })
    console.log('shot', name, JSON.stringify(img.getSize()), 'focus:', focus)
  }
  const key = async (keyCode, modifiers = []) => {
    wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
    wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
    await sleep(120)
  }
  const step = async (name, fn) => {
    try {
      await fn()
    } catch (e) {
      console.log('STEP FAILED', name, e.message)
      metrics.steps.push({ name, failed: e.message })
    }
  }

  await ready()

  /* ------------------------------------------------------------- seeding */
  const seed = await ev(`
    const h = window.harbor
    const u = (r) => { if (!r.ok) throw new Error(r.error); return r.data }
    await h.settings.set('local_base_url', ${JSON.stringify(base)})
    await h.settings.set('last_model', 'local/audit')
    await h.key.set('sk-or-v1-audit-fake-key')
    await h.models.toggleFavorite('aion-labs/aion-3.5')
    await h.models.toggleFavorite('aion-labs/aion-2.0')
    const project = u(await h.projects.create('Audit project', ${JSON.stringify(PROJ)}))
    const long = u(await h.conversations.create(project.id, 'local/audit'))
    await h.conversations.rename(long.id, 'A long conversation about the harbour and everything that happened there over the years')
    let parent = null
    for (let i = 0; i < 60; i++) {
      const role = i % 2 === 0 ? 'user' : 'assistant'
      const content = role === 'user'
        ? (i % 6 === 0 ? 'Short question ' + i + '?' : 'A longer user message number ' + i + ' that goes on a bit so the bubble has to wrap across more than one line, and includes a path like src/index.ts and a URL https://example.com/some/long/path/that/keeps/going.')
        : (i % 4 === 1 ? ${JSON.stringify(MD)} : 'Reply ' + i + '. ' + 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(1 + (i % 5)))
      const m = u(await h.messages.add(long.id, parent, role, content, role === 'assistant' ? 'local/audit' : null))
      parent = m.id
    }
    const fresh = u(await h.conversations.create(project.id, 'local/audit'))
    const old = u(await h.projects.create('An archived project', null))
    await h.projects.setArchived(old.id, true)
    await h.conversations.rename(fresh.id, 'Audit B')
    for (let i = 0; i < 40; i++) {
      const c = u(await h.conversations.create(project.id, 'local/audit'))
      await h.conversations.rename(c.id, 'Filler conversation ' + i + (i % 3 === 0 ? ' with a title long enough to be cut off in the sidebar' : ''))
    }
    for (let i = 0; i < 12; i++) await h.prompts.save(null, null, 'Prompt ' + i, 'Body of prompt ' + i + ' with {{variable}}')
    await h.memory.add(project.id, 'The harbour office opens at eight.')
    await h.memory.add(project.id, 'Berth fees are posted on the board.')
    return { project: project.id, long: long.id, fresh: fresh.id }
  `)
  note('seeded', seed)
  wc.reload()
  await sleep(1500)
  await ready()
  await sleep(2500)
  note('models after reload', await ev(`const r = await window.harbor.models.list(); return r.ok ? r.data.map((m) => m.id).slice(0, 5) : r.error`))
  note('key status', await ev(`return await window.harbor.key.status()`))

  /* --------------------------------------------------------------- walk */
  await step('empty', async () => {
    await shot('01-empty')
  })
  await step('sidebar-scroll', async () => {
    const info = await ev(`const s = document.querySelector('.sidebar__scroll'); if (!s) return null; const r = { scrollHeight: s.scrollHeight, clientHeight: s.clientHeight, rows: document.querySelectorAll('.row').length }; s.scrollTop = s.scrollHeight; return r`)
    note('sidebar', info)
    await shot('02-sidebar-bottom')
    await ev(`const s = document.querySelector('.sidebar__scroll'); if (s) s.scrollTop = 0; return true`)
  })
  await step('long-conversation', async () => {
    await ev(`const b = [...document.querySelectorAll('.zone__more')].find((e) => /Show all/.test(e.textContent)); return window.__aud.click(b)`)
    await sleep(300)
    await shot('02b-project-expanded')
    const ok = await ev(`return window.__aud.click(window.__aud.byText('A long conversation about the harbour and everything that happened there over the years', '.row, .row__label, button, div'))`)
    note('opened long conversation', ok)
    await sleep(900)
    const info = await ev(`const s = window.__aud.scroller(); const msgs = document.querySelectorAll('.msg').length; const r = { msgs, scrollHeight: s && s.scrollHeight, clientHeight: s && s.clientHeight, cls: s && s.className, nodes: document.querySelectorAll('*').length }; if (s) s.scrollTop = 0; return r`)
    note('long conversation', info)
    await shot('03-long-top')
    await ev(`const s = window.__aud.scroller(); if (s) s.scrollTop = s.scrollHeight; return true`)
    await shot('04-long-bottom')
    await ev(`const s = window.__aud.scroller(); if (s) s.scrollTop = s.scrollHeight / 2; return true`)
    await shot('05-long-middle')
  })
  await step('streaming', async () => {
    await ev(`return window.__aud.click(window.__aud.byText('Audit B', '.row, .row__label, button, div'))`)
    await sleep(700)
    await ev(`window.__aud.setInput(document.querySelector('.composer__input'), 'A **rich** box:\\n\\n- one\\n- two\\n\\n\`\`\`ts\\nconst a = 1\\n\`\`\`\\n\\n> a quote'); return true`)
    await shot('06-composer-rich')
    note('markdown the box would send', await ev(`return window.__composerEditor.getMarkdown()`))
    await ev(`window.__aud.setInput(document.querySelector('.composer__input'), 'SLOW please stream a reply'); return true`)
    await shot('06b-composer-typed')
    await ev(`return window.__aud.click(document.querySelector('.send'))`)
    await sleep(600)
    await shot('07-streaming-early')
    await sleep(3000)
    await shot('08-streaming-mid')
    for (let i = 0; i < 40; i++) {
      const done = await ev(`return !document.querySelector('.send--stop')`)
      if (done) break
      await sleep(500)
    }
    await sleep(800)
    await shot('09-reply-markdown')
    const hover = await ev(`const m = [...document.querySelectorAll('.msg')].pop(); if (!m) return null; m.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); const f = m.querySelector('.msg__foot'); return f ? { foot: f.textContent.trim().slice(0, 200), opacity: getComputedStyle(f).opacity } : null`)
    note('message foot on hover', hover)
  })
  await step('failed-turn', async () => {
    await ev(`window.__aud.setInput(document.querySelector('.composer__input'), 'FAIL this one'); return true`)
    await ev(`return window.__aud.click(document.querySelector('.send'))`)
    await sleep(2500)
    await shot('10-failed-turn')
    const err = await ev(`const e = document.querySelector('.msg__error, .notice, [class*=notice], [class*=error]'); return e ? e.className + ': ' + e.textContent.trim().slice(0, 200) : null`)
    note('failure shown as', err)
  })
  await step('tool-turn', async () => {
    const toggled = await ev(`const b = window.__aud.byText('Chat only'); if (!b) return 'already agent'; window.__aud.click(b); return 'toggled'`)
    note('agent toggle', toggled)
    await sleep(400)
    await ev(`window.__aud.setInput(document.querySelector('.composer__input'), 'TOOL write the notes'); return true`)
    await ev(`return window.__aud.click(document.querySelector('.send'))`)
    for (let i = 0; i < 60; i++) {
      await sleep(500)
      const done = await ev(`return !document.querySelector('.send--stop')`)
      if (done && i > 3) break
    }
    await sleep(600)
    await shot('11-tool-turn')
    const tool = await ev(`const t = document.querySelector('[class*=tool]'); return t ? t.className + ': ' + t.textContent.trim().slice(0, 160) : null`)
    note('tool row', tool)
  })
  await step('inspector-panes', async () => {
    for (const [part, name] of [['Changes', '12-changes'], ['Terminal', '13-terminal'], ['Explorer', '14-files']]) {
      const ok = await ev(`return window.__aud.click(window.__aud.byTitle(${JSON.stringify(part)}))`)
      note('open pane ' + part, ok)
      await sleep(700)
      await shot(name)
    }
    const opened = await ev(`const d = [...document.querySelectorAll('.explorer__row--dir')].find((e) => e.querySelector('.explorer__name')?.textContent.trim() === 'src'); return window.__aud.click(d)`)
    note('expand src', opened)
    await sleep(500)
    await shot('15-files-src')
    const file = await ev(`const f = [...document.querySelectorAll('.explorer__open')].find((e) => (e.title || '').endsWith('index.ts')); return window.__aud.click(f)`)
    note('open index.ts', file)
    await sleep(800)
    await shot('16-fileview')
  })
  await step('composer-menus', async () => {
    await ev(`window.__aud.setInput(document.querySelector('.composer__input'), '/'); return true`)
    await sleep(300)
    await shot('17-slash-menu')
    await ev(`window.__aud.setInput(document.querySelector('.composer__input'), 'a question for several'); return true`)
    const ask = await ev(`return window.__aud.click(window.__aud.byTitle('several models'))`)
    note('askmany opened', ask)
    await sleep(300)
    await shot('18-askmany')
    await ev(`const c = window.__aud.byText('Cancel'); window.__aud.click(c); window.__aud.setInput(document.querySelector('.composer__input'), ''); return true`)
    const picker = await ev(`return window.__aud.click(document.querySelector('.composer__model'))`)
    note('model picker', picker)
    await sleep(600)
    await shot('19-model-picker')
    await key('Escape')
    await sleep(300)
    const params = await ev(`return window.__aud.click(window.__aud.byTitle('parameter'))`)
    note('params opened', params)
    await sleep(500)
    await shot('20-params')
    await key('Escape')
  })
  await step('sheets', async () => {
    const sheets = [['Settings', '21-settings'], ['Context', '23-context'], ['Usage', '24-usage'], ['Log', '25-log'], ['Plan', '26-plan-a-run']]
    for (const [label, name] of sheets) {
      const before = await ev(`return window.__aud.focusPath()`)
      const ok = await ev(`return window.__aud.click(window.__aud.byText(${JSON.stringify(label)}))`)
      await sleep(800)
      const has = await ev(`return !!document.querySelector('.sheet')`)
      note('sheet ' + label, { clicked: ok, open: has })
      await shot(name)
      if (label === 'Settings') {
        const info = await ev(`const p = document.querySelector('.sheet__body') || window.__aud.scroller(); if (!p) return null; const r = { scrollHeight: p.scrollHeight, clientHeight: p.clientHeight, fields: document.querySelectorAll('.field').length, inputs: document.querySelectorAll('.sheet input, .sheet textarea, .sheet select').length }; p.scrollTop = p.scrollHeight; return r`)
        note('settings size', info)
        await shot('22-settings-bottom')
        // Integrations, with the Claude Code bridge turned on so its port, cap and command show.
        await ev(`return window.__aud.click(window.__aud.byText('Integrations', '.settings__tab'))`)
        await sleep(400)
        await ev(`const c = [...document.querySelectorAll('.field')].find((f) => /Claude Code/.test(f.textContent || '')); const box = c && c.querySelector('input[type=checkbox]'); if (box && !box.checked) box.click(); return !!box`)
        await sleep(800)
        await shot('22b-settings-integrations')
      }
      await key('Escape')
      await sleep(400)
      const stillOpen = await ev(`return !!document.querySelector('.sheet')`)
      const after = await ev(`return window.__aud.focusPath()`)
      note('escape closes ' + label, { stillOpen, focusBefore: before, focusAfter: after })
      if (stillOpen) {
        await ev(`return window.__aud.click(window.__aud.byTitle('Close'))`)
        await sleep(300)
      }
    }
  })
  await step('search', async () => {
    const ok = await ev(`return window.__aud.click(window.__aud.byTitle('search'))`)
    note('search opened', ok)
    await sleep(500)
    await ev(`const i = document.querySelector('.sheet input, .sheet textarea'); if (i) window.__aud.setInput(i, 'harbour'); return !!i`)
    await sleep(900)
    await shot('27-search')
    await key('Escape')
    await sleep(300)
  })
  await step('project-sheet', async () => {
    const ok = await ev(`return window.__aud.click(window.__aud.byText('Audit project', '.zone__title, button, span, div'))`)
    note('project title click', ok)
    await sleep(600)
    await shot('28-project-title-click')
    await key('Escape')
    await sleep(200)
    const ok2 = await ev(`const z = window.__aud.byText('Audit project', '.zone__title, button, span, div'); const zone = z && z.closest('.zone'); const b = zone && [...zone.querySelectorAll('button')].find((x) => /project|settings|edit|open/i.test(x.title || '')); return b ? (window.__aud.click(b), b.title) : null`)
    note('project sheet via zone button', ok2)
    await sleep(600)
    await shot('29-project-sheet')
    await key('Escape')
    await sleep(200)
  })
  await step('keyboard', async () => {
    await ev(`document.querySelector('.composer__input').focus(); return true`)
    const order = []
    for (let i = 0; i < 28; i++) {
      await key('Tab')
      order.push(await ev(`return window.__aud.focusPath()`))
    }
    const focusables = await ev(`return [...document.querySelectorAll('a[href],button,input,textarea,select,[tabindex]')].filter((e) => !e.disabled && e.tabIndex >= 0 && e.offsetParent !== null).length`)
    note('tab order', { focusables, order })
    fs.writeFileSync(path.join(OUT, 'tab-order.json'), JSON.stringify({ focusables, order }, null, 2))
    await shot('30-after-tabs')
    await ev(`return window.__aud.click(window.__aud.byText('Settings'))`)
    await sleep(600)
    const inSheet = []
    for (let i = 0; i < 6; i++) {
      await key('Tab')
      inSheet.push(await ev(`return window.__aud.focusPath()`))
    }
    note('tab inside settings sheet', inSheet)
    await key('Escape')
    await sleep(300)
  })
  await step('director-review', async () => {
    // A director with a board, and a review posted through the bridge the way Claude Code would post one.
    const made = await ev(`
      const h = window.harbor
      const u = (r) => { if (!r.ok) throw new Error(r.error); return r.data }
      const d = u(await h.conversations.startDirector(${JSON.stringify(seed.project)}, 'local/audit', 3))
      await h.conversations.rename(d.id, 'Director (Claude)')
      const st = u(await h.bridge.configure({ enabled: true, port: 47699 }))
      return { id: d.id, runDir: d.runDir, command: st.command, running: st.running }
    `)
    note('director made', { runDir: made.runDir, running: made.running })
    fs.mkdirSync(path.join(PROJ, made.runDir), { recursive: true })
    fs.writeFileSync(path.join(PROJ, made.runDir, 'tasks.md'), '# Board\n\n- [x] T1 — Write the tide table parser\n  - tier: standard\n  - done-when: the parser has a units section\n- [~] T2 — Draft the berth schedule view\n- [ ] T3 — Map the harbour zones\n- [!] Q1 — Open items on the parser\n  - Which units the source files use (metres or feet).\n  - Which timezone the tables are in.\n- [!] Q2 — Schedule rules\n  - How overlapping bookings are resolved: first come, or by vessel size.\n')
    fs.writeFileSync(path.join(PROJ, made.runDir, 'design.md'), '# Design\n')
    const token = /Bearer ([^"]+)"/.exec(made.command)[1]
    const res = await fetch('http://127.0.0.1:47699/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: 'Bearer ' + token },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'post_review', arguments: {
        director: made.id, verdict: 'needs work',
        summary: 'The plan covers the outcome, but **Done means** asks for a units section in the parser and T1 has none. T3 is not in the requirements.',
        suggestions: [
          { text: 'Ask T1 for a units section, as Done means requires; the rest of the parser holds up.', task: 'T1' },
          { text: 'Drop T3 or tie it to a requirement: nothing asks for a map.', task: 'T3' },
          { text: 'The design names two data sources; the requirements ask for one. Settle which before T2 goes further.' }
        ]
      } } })
    })
    note('review posted', { status: res.status, body: (await res.text()).slice(0, 160) })
    await sleep(800)
    await shot('27a-review-notice')
    note('open from the notice', await ev(`const b = document.querySelector('.notice .btn'); if (b) b.click(); return !!b`))
    await sleep(1500)
    await shot('27-run-view-review')
    note('header waiting button', await ev(`const b = [...document.querySelectorAll('.run__waiting')][0]; return b ? b.textContent : null`))
    await ev(`const b = document.querySelector('.run__waiting'); if (b) b.click(); return !!b`)
    await sleep(900)
    await shot('28-run-view-waiting')
    await ev(`const b = [...document.querySelectorAll('.run-view__waiting .btn')][0]; if (b) b.click(); return !!b`)
    await sleep(500)
    note('answer drafted', await ev(`return { text: window.__composerEditor?.getMarkdown(), focus: document.activeElement?.className }`))
    await shot('29-run-view-answer')
    await ev(`return window.harbor.bridge.configure({ enabled: false })`)
  })
  await step('resize', async () => {
    win.setSize(900, 620)
    await sleep(700)
    await shot('31-narrow-900')
    win.setSize(640, 480)
    await sleep(700)
    await shot('32-tiny-640')
    const overflow = await ev(`return { docW: document.documentElement.scrollWidth, winW: innerWidth, minW: getComputedStyle(document.body).minWidth }`)
    note('tiny overflow', overflow)
    win.setSize(1440, 900)
    await sleep(600)
  })
  await step('light-theme', async () => {
    nativeTheme.themeSource = 'light'
    await sleep(600)
    await shot('33-light-theme')
    const bg = await ev(`return getComputedStyle(document.body).backgroundColor`)
    note('body background in light mode', bg)
    nativeTheme.themeSource = 'dark'
    await sleep(300)
  })
  await step('launcher', async () => {
    const lw = offscreen('launcher.html', 640, 440)
    await sleep(1500)
    const lev = (code) => lw.webContents.executeJavaScript(`(async () => { ${code} })()`, true)
    await lev(`const i = document.querySelector('.launcher__input'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, 'sa'); i.dispatchEvent(new Event('input', { bubbles: true })); return true`)
    await sleep(900)
    const img = await lw.webContents.capturePage()
    fs.writeFileSync(path.join(OUT, '34-launcher.png'), img.toPNG())
    const items = await lev(`return [...document.querySelectorAll('.launcher__item')].map((e) => e.textContent.trim().slice(0, 40))`)
    note('launcher items for "sa"', items)
    await lev(`const i = document.querySelector('.launcher__input'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, '@aud'); i.dispatchEvent(new Event('input', { bubbles: true })); return true`)
    await sleep(700)
    const img2 = await lw.webContents.capturePage()
    fs.writeFileSync(path.join(OUT, '35-launcher-at.png'), img2.toPNG())
    await lev(`const i = document.querySelector('.launcher__input'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, ''); i.dispatchEvent(new Event('input', { bubbles: true })); return true`)
    await sleep(500)
    const img3 = await lw.webContents.capturePage()
    fs.writeFileSync(path.join(OUT, '36-launcher-empty.png'), img3.toPNG())
  })
  await step('quick-question-window', async () => {
    throw new Error('skipped: a pop-out is a visible window')
    const popped = await ev(`const h = window.harbor; const u = (r) => { if (!r.ok) throw new Error(r.error); return r.data }; const c = u(await h.conversations.create(${JSON.stringify(seed.project)}, 'local/audit', true)); await h.popOut(c.id); return c.id`)
    await sleep(1500)
    const pw = BrowserWindow.getAllWindows().find((w) => w !== win && w.getSize()[0] !== 640)
    if (!pw) throw new Error('no pop-out window')
    pw.hide()
    const img = await pw.webContents.capturePage(undefined, { stayHidden: true })
    fs.writeFileSync(path.join(OUT, '37-popout.png'), img.toPNG())
    note('pop-out size', pw.getSize())
  })

  fs.writeFileSync(path.join(OUT, 'metrics.json'), JSON.stringify(metrics, null, 2))
  console.log('DONE', metrics.steps.length, 'steps')
  server.close()
  app.exit(0)
}).catch((e) => {
  console.log('WALK FAILED', e.stack)
  fs.writeFileSync(path.join(OUT, 'metrics.json'), JSON.stringify(metrics, null, 2))
  app.exit(1)
})
setTimeout(() => { console.log('TIMEOUT'); app.exit(2) }, 240_000)
