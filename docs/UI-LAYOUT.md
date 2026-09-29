# Harbor — App shell layout

Structure modelled on the Claude Code desktop window (layout only, not colour or type).
Reference captured 2026-09-08. Supersedes the earlier sidebar-only note.

---

## Three panes

```
┌──────────────┬────────────────────────────┬──────────────────────────┐
│ ⬤⬤⬤ ▣ ← →   │ ▤ Local chat interfac…  ▤ │ ☰ │ BUNDLE.md ×     ⌕⋮⇱× │
│        [💬][</>]│           >_  ▤  ⊕     ⋮ │                    </> │
├──────────────┼────────────────────────────┼──────────────────────────┤
│ + New        │                            │  # Harbor — Scope        │
│ ◈ Memories   │  assistant text, no bubble │                          │
│ ▦ Prompts    │                            │  ## 1. What Harbor is    │
│ ⌄ More       │  ▸ Ran 2 commands          │  A single-user macOS…    │
│              │                            │                          │
│ harbor-ai +⌕⇅│      ┌──────────────────┐  │  ## 2. Decisions locked  │
│ ● Sidebar la…│      │ user message     │  │  ┌────┬────┬────┐        │
│ ○ Model pick…│      └──────────────────┘  │  │ …  │ …  │ …  │        │
│              │                            │  └────┴────┴────┘        │
│ website     +│  assistant text            │                          │
│ ⚠ Deploy pip…│                        ⌄   │                          │
│ ○ Release no…│  ┌──────────────────────┐  │                          │
│              │  │ Type / for commands  │  │                          │
│ practice-labs+│  └──────────────────────┘  │                          │
└──────────────┴────────────────────────────┴──────────────────────────┘
   280px            flex, min 480px            380px, resizable to 50%
```

Window minimum 1100 × 700. Side panes collapse from the chrome toggles; the conversation
pane never collapses.

---

## Pane 1 — Sidebar (280px, resizable 240–400)

### Chrome row
Traffic lights, sidebar toggle, back/forward. Right-aligned: a two-button segmented
control that sets what the **right pane** shows — `💬` transcript-adjacent context vs
`</>` file inspector.

### Zone 1 — Destinations
Compact by default. `+ New`, then two or three pinned destinations, then a `⌄ More`
disclosure holding the rest.

Harbor's set: **New** · **Context** · **Prompts** · then under More: **Usage**,
**Checkpoints**, **Settings**.

**Context** opens a three-tab view — **Skills · Knowledge · Memory** — mirroring the three
channels in `docs/CONTEXT-MODEL.md`. One destination rather than three keeps Zone 1 compact
and makes the taxonomy visible in the UI.

`New` has no button chrome — it is the first row and the `+` icon carries it.

### Zone 2 — Projects as top-level sections

The important correction from the earlier reference: **each project is its own section
header**, not a row nested under a single "Projects" heading. Flatter, far more scannable
once you have more than three projects.

```
harbor-ai                    +  ⌕  ⇅      ← active project gets all three
○ Sidebar layout                          ← conversations, circle bullet
● Local chat interface                    ← selected: rounded fill
⚠ Agent run — approve command             ← trailing status slot

website                      +            ← inactive: + only
○ Contact form validation
```

- Header: project name, muted, sentence case. Right-aligned affordances: `+` new
  conversation **in that project**. The active project additionally gets search and
  filter/sort.
- Children are conversations, recency-ordered, single line, ellipsis-truncated.
- No vertical guide rail, no indentation beyond the row's own padding — the header
  weight does the grouping.

### Status slot
Leading position on a conversation row, replacing the bullet. Three states:

| Icon | Meaning |
|---|---|
| ◌ spinner | agent run in progress |
| ⚠ triangle | run blocked, waiting on your command approval |
| ✕ | run failed |

This is load-bearing. Commands are approval-gated, so a run in a project you are not
looking at can sit blocked forever. The sidebar is where you find out.

---

## Pane 2 — Conversation (flex, min 480px)

### Header
Project icon, conversation title (ellipsis-truncated), a muted pill showing the owning
project (`harbor-ai`), then a folder button that reveals the project root. Right-aligned quick-actions, each toggling a right-pane mode:

| Icon | Opens |
|---|---|
| `>_` | Terminal — command approvals and shell output |
| `▣` | Changes — what the agent wrote this run, with revert |
| `🌐` | Browser — deferred past v1, slot reserved |
| `⋮` | Conversation menu: model, params, export, delete |

Clicking the icon of an already-open mode closes the inspector. The Files mode has no
header icon — it opens when you click a file link (see below).

### Transcript
- Assistant messages: bare text on the pane background, full width, no bubble.
- User messages: rounded filled bubble, inset from the right.
- Images render inline in a rounded frame.
- **Tool calls collapse to a single row** — `▸ Ran 2 commands`, `▸ Edited 3 files`,
  `▸ Searched for "safeStorage"`. Expand for arguments and full output. This is what
  keeps an agent transcript readable.
- Branch switcher `◀ 2/3 ▶` appears on any message with siblings.
- **Following a reply.** The view follows new text while you are already at the
  bottom, and stops the moment you scroll up to read something — at which point
  the jump-to-bottom control appears. It follows tool rows too, not just
  streamed prose, because a tool-heavy run grows the transcript without emitting
  a word and that is exactly when there is most to watch. Opening a conversation
  always starts at its latest message.

### Todo strip
While a run is active, a pinned card sits directly above the composer showing the agent's
live checklist. It collapses to a one-line summary (`3 of 5 done`) and disappears when the
run ends. Not in the transcript — it changes too often to belong in the scroll history.

### Composer
Rounded, multi-line, placeholder `Type / for commands`. Images, PDFs and text
files can be **pasted or dragged straight in**, not only chosen from the file
dialog — a screenshot on the clipboard is the common case and going via a Save
dialog first would be absurd. Pasting an image alongside text attaches the image
and lets the text land normally, rather than swallowing half of what was copied.

An attached **image shows itself** — a 54px thumbnail rather than a filename,
because "Pasted 2026-09-08T14-32-01.png" identifies nothing and you need to see
what you actually added before sending it. PDFs and text files keep their names,
which for those is the useful part. The `/` menu is where the **prompt
library** lives — this is the natural home for it, no separate surface needed. Attach
button at the right. Model chip and live context meter sit on the composer's bottom edge.

---

## Pane 3 — Inspector (380px, resizable to 50%)

One pane, four modes. Three are reachable from the conversation header; the fourth (Files)
opens on demand when you click a file.

| Header icon | Mode | v1 |
|---|---|---|
| `>_` | **Terminal** | yes |
| `▣` | **Changes** — diff view | yes |
| `🌐` | **Browser** | deferred |
| — | **Files** — opens when a file link is clicked | yes |

Clicking an active mode's icon closes the pane. The icon lights up while its mode is open.

### Terminal
Tabbed — `+` in the tab bar spawns another shell in the project root. Agent commands and
commands you type yourself share the same scrollback, so the full sequence reads in order.

Approvals are **not** here. A pane can be covered by whatever else is open, and a run
blocked on a question nobody can see is indistinguishable from the app having hung — which
is exactly what it looked like. The question is asked in the conversation, above the
composer, where it cannot be hidden; the output still lands here once it is answered.

Shells survive pane collapse and reconnect with buffered output replayed on return.

### Changes
Every file the agent auto-applied in the current run, as a diff list. Per-file diff,
per-edit undo, revert-whole-run. Empty state reads `No changes to show`.

Because edits land without a gate, this is the safety net — it opens automatically the
first time a run writes to disk.

### Files
Tab bar with a `☰` tree toggle on the left, then one tab per open file, each closable.
Under the tab bar, a breadcrumb of the path relative to the project root
(`docs / UI-LAYOUT.md`). A `</>` control at the top-right of the content area switches
rendered ↔ raw source; markdown renders, code is syntax-highlighted.

### Shared pane chrome
Right-aligned in every mode: search-in-pane, `⋮` menu, open-in-external-editor, expand,
close.

---

## Opening files from the conversation

Any reference to a local file in the transcript is a link, and clicking it opens that file
in the inspector as a new tab. This applies to:

- file paths the agent writes in prose, including the far commoner case of a path in
  inline code — recognised by extension rather than by shape, because no shape test
  distinguishes `docs/BUNDLE.md` from `module.exports`
- the file list inside a collapsed `▸ Edited 3 files` tool row
- search-tool results
- entries in the Changes diff list

Links resolve relative to the project root and are subject to the same path jail as the
agent's tools — a link pointing outside the project does not open, it explains why.

---

## Panel collapse

Both side panes collapse; the conversation pane never does.

- Sidebar collapses from the chrome toggle, leaving the conversation full-bleed.
- Inspector collapses by clicking its active mode icon again, or the pane's `×`.
- Collapse state is remembered per project, not globally — an agent-heavy project reopens
  with the inspector out, a pure-chat project without it.
- Both panes are drag-resizable from their inner edge; widths persist.
- The inspector `⤢` expands it to fill the window over the conversation, for reading a long
  file or a large diff. Escape returns it.

## Right-click

Context menus are real macOS menus built in the main process, not HTML
imitations — a right-click should give the system's own menu, with its keyboard
handling and edge placement.

| On | Offers |
|---|---|
| A conversation | Rename, Pin, Archive, Delete |
| A project header | New conversation, Search, Show archived, Settings, Delete project |
| A message | Copy, Edit and fork *or* Retry and Remember this, Delete |

Anything irreversible confirms through a native dialog before it happens, and
deleting the last project is disabled rather than merely discouraged.

**Archiving** keeps a conversation and its history; it only leaves the sidebar,
stays findable in search, and the project header shows a count to bring it back.

---

## Failures are visible

Errors that flow through a turn were always shown in the transcript, but
everything else was dropped: a rejected IPC call left the interface unchanged,
which reads as the app ignoring you. Attaching a file over the size limit was
the clearest case — a carefully worded message went nowhere and the click
appeared to do nothing.

Failures now appear just above the composer, where the eye already is. Errors
stay until dismissed; softer notices fade. Repeats collapse, because the same
failure happening twice is one problem.

Three layers, so nothing is silent:

1. **Named sites** report what went wrong — attaching, undoing, reverting,
   saving a skill or prompt, adding knowledge, running a command.
2. **Unwrapping an IPC result** reports before it throws, covering every call
   site at once rather than one at a time.
3. **A global backstop** catches unhandled rejections, window errors, and
   uncaught exceptions in the main process, so a failure nobody anticipated
   still surfaces instead of vanishing.

---

## Colour has one meaning

Red is for two things and nothing else: something failed, or this destroys
something that cannot be recovered. A tool row is judged on its own calls, not
on whether anything in the conversation ever failed — otherwise one error turns
every row red and the colour stops meaning anything. It is deliberately *not* used for stopping a
stream, denying a command, undoing an edit, reverting a run, or clearing a
field. Several of those are the safest action available, and colouring them like
an error argues against taking them.

---

## Row anatomy

One object everywhere in the sidebar:

```
[ 16px icon/status ] [ label — 1 line, ellipsis ] [ badge? ]
```

Row height 32px, icon slot 16px, gap 10px, inner padding 8px, corner radius 6px.
Hover: subtle fill. Selected: stronger fill, same radius.

Badges carry model-capability marks — a `no tools` tag on a conversation pinned to a model
that cannot run the agent, so you see why agent mode is off before you try.

---

## Deliberate omissions

- **No dividers** anywhere. Whitespace and header weight separate.
- **No unread counts or dots.** Single-user; nothing accumulates unseen.
- **No nested project folders.** One level. Depth belongs in the filesystem.
- **No separate Prompts screen.** The `/` menu in the composer is the prompt library.
