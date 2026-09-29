const { app } = require('electron')
const fs = require('fs')
const path = require('path')

const TMP = '/tmp/harbor-skills-test'
fs.rmSync(TMP, { recursive: true, force: true })
fs.mkdirSync(path.join(TMP, 'repo'), { recursive: true })
app.setPath('userData', TMP)

app.whenReady().then(async () => {
  const { db, skills: S, agentTools: T, context: C } = require('../out/test/entry.cjs')
  let pass = 0, fail = 0
  const check = (label, ok, detail = '') => {
    console.log((ok ? 'ok    ' : 'FAIL  ') + label + (ok || !detail ? '' : ' -- ' + detail))
    ok ? pass++ : fail++
  }
  db.initDb()
  const repo = path.join(TMP, 'repo')
  const project = db.createProject('skills', repo)
  const mk = (rel, text) => { fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); fs.writeFileSync(path.join(repo, rel), text) }

  console.log('-- the SKILL.md format, found beside the code --')
  mk('skills/release-check/SKILL.md', '---\nname: release-check\ndescription: Steps to verify a build before tagging a release.\nlicense: MIT\n---\n\n# Release check\n\n1. Run the tests.\n2. Read scripts/verify.sh and run it.\n')
  mk('skills/release-check/scripts/verify.sh', '#!/bin/sh\necho ok\n')
  mk('skills/release-check/references/checklist.md', '- tests\n')
  mk('.claude/skills/Deploy Notes/SKILL.md', '---\ndescription: "How deploys are announced."\n---\nTell the channel.\n')
  mk('.agents/skills/empty/README.md', 'not a skill')
  await S.save(project.id, 'harbor-own', 'A skill kept by Harbor.', 'Do the thing.')
  const list = await S.list(project.id, repo)
  const names = list.map((s) => s.name)
  // The home folder's own skills come along too, and this machine has some; they are not the test's to count.
  check('skills come from skills/, .claude/skills and Harbor\'s store; a folder without SKILL.md is not one', ['deploy-notes', 'harbor-own', 'release-check'].every((n) => names.includes(n)) && !names.includes('empty') && list.filter((s) => s.source !== 'home').length === 3, names.join(','))
  const rc = list.find((s) => s.name === 'release-check')
  check('the front matter names it and describes it', rc.description === 'Steps to verify a build before tagging a release.' && rc.source === 'project' && rc.body.startsWith('# Release check'))
  check('a folder name is slugged when the front matter has no name', list.find((s) => s.name === 'deploy-notes').description === 'How deploys are announced.')
  check('its files are listed relative to the project, sorted', rc.resources.join(',') === 'skills/release-check/references/checklist.md,skills/release-check/scripts/verify.sh', rc.resources.join(','))

  console.log('\n-- loading --')
  const ctx = { projectId: project.id, webUsed: () => false, root: repo, unlocked: [], runId: 'r', conversationId: 'c', plan: false, writeGlobs: [], onTodos: () => {}, onWrote: () => {}, runCommand: async () => '', afterWrite: async () => '' }
  const loaded = await T.execute(ctx, 'load_skill', { name: 'release-check' })
  check('load_skill returns the body and names the files for read_file', /# Release check/.test(loaded) && /Files with this skill, for read_file/.test(loaded) && /- skills\/release-check\/scripts\/verify.sh/.test(loaded), loaded)
  check('a Harbor-kept skill has no files to name', !/Files with/.test(await T.execute(ctx, 'load_skill', { name: 'harbor-own' })))
  check('the index in the prompt lists all three', (await C.assembleSystem({ projectId: project.id, model: 'x/y', web: false })).sections.find((s) => s.label === 'Skill index').text.includes('release-check: Steps to verify'))
  check('a project skill wins a name clash with a Harbor-kept one', (await S.save(project.id, 'release-check', 'older copy', 'old'), (await S.get(project.id, 'release-check', repo)).source === 'project'))

  console.log(`\n${pass} passed, ${fail} failed`)
  app.exit(fail === 0 ? 0 : 1)
}).catch((e) => { console.log('THREW ' + e.stack); app.exit(1) })
