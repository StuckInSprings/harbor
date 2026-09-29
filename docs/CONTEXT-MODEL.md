# Harbor — Context model

Three channels feed the agent. Every piece of information entering a project routes to
exactly one of them, decided by a single question: **what kind of thing is this?**

| Channel | Holds | Test |
|---|---|---|
| **Skill** | A repeatable procedure the agent should follow | "These are the steps for doing X" |
| **Knowledge** (RAG) | Information that has been written down | "This is recorded somewhere" |
| **Memory** | Knowledge picked up through experience | "We learned this by doing" |

The taxonomy is not decoration — it determines how each thing is stored, retrieved, and
budgeted, and it is what makes automatic memory extraction safe enough to ship. A fact
that came from a document is not a memory; it belongs in Knowledge. A procedure is not a
memory; it belongs in a Skill. Memory holds only what was learned in the doing.

---

## 1. Skills — procedures

A skill is a named markdown procedure with a one-line description.

```
name:        release-check
description: Steps to verify a build before tagging a release
body:        markdown — the actual procedure
```

**Storage.** Project-scoped or global, on disk as plain markdown so they are editable
outside Harbor and diffable in git.

**Retrieval — progressive disclosure.** Only the *index* (name + description of every
skill) sits in the system prompt; a hundred skills cost a few hundred tokens. The agent
calls `load_skill(name)` to pull a full body into context when it decides one applies. You
can force one with `/release-check` in the composer.

This is deliberate. Description-matching that silently injects full bodies is unpredictable
and expensive; an explicit tool call is visible in the transcript as `▸ Loaded skill
release-check` and shows up in the context meter.

## 2. Knowledge — written-down information

A knowledge source is a file or folder you add to a project: docs, notes, transcripts,
PDFs, specs, exported wikis.

**Indexing.** Markdown-aware chunking on heading boundaries, ~512 tokens with overlap,
each chunk keeping its file path and heading trail for citation. Re-indexed incrementally
by content hash when a watched file changes.

PDFs are extracted with a pure-JavaScript reader rather than OpenRouter's parser, so
indexing stays free and offline like the embeddings. A PDF with no text layer yields
nothing, which is the honest outcome — that needs OCR, which is a different job.

Images are not indexed. Embedding them would mean a CLIP-family model, a second vector
space, and retrieval that is poor at exactly the document-image case. The better answer,
if it is ever wanted, is to caption each image with a cheap vision model at index time and
embed the caption: it reuses this whole pipeline and makes an image findable in the same
vocabulary as the documents around it.

**Embeddings run locally.** A small bundled model (`bge-small-en-v1.5` via ONNX) rather
than a remote embedding API — indexing is then free, offline, and does not need a second
provider key. A remote embedding provider is a setting for anyone who wants better recall.

**Search is hybrid.** SQLite with FTS5 (BM25) and `sqlite-vec` in the same database, fused
by reciprocal rank. Measured on this project's own docs, the vector half retrieves a
paraphrase with no shared keywords that BM25 cannot find, and the lexical half retrieves
exact identifiers that embeddings rank poorly — each covers the other's blind spot.

Two guards stop retrieval from filling context with noise. Nearest-neighbour search always
returns something, so results past a distance cutoff are dropped and results merely close
to it are labelled, letting the model say the corpus does not cover a question instead of
citing the least-bad passage. And stopwords are stripped from the BM25 side, because
OR-ing a term like "for" matches an entire corpus.

**Retrieval is agent-driven.** The agent calls `search_knowledge(query, k)` when it needs
grounding, rather than Harbor pre-retrieving on every turn. Automatic retrieval injects
noise into the many turns that do not need it. Retrieved chunks are cited by file and
heading, and every citation is a clickable link that opens the source in the inspector.

### Knowledge is not the workspace

These are separate and must not be conflated:

| | Workspace (`search` tool) | Knowledge (`search_knowledge` tool) |
|---|---|---|
| Over | The project's root folder — code | A curated corpus you added |
| Method | Exact: grep and glob | Semantic + BM25 hybrid |
| Freshness | Live, every call | Indexed, refreshed on change |
| Writable | Yes, the agent edits it | No, read-only |

A project can have both. Code lives in the workspace; documents live in Knowledge.

## 3. Memory — experiential knowledge

Facts the agent learned by working with you, extracted automatically after a turn settles.

**The extraction rubric is the taxonomy.** The extractor is instructed to record only
what was learned through interaction, and explicitly to reject:

- anything restating a document → Knowledge
- anything shaped like a procedure → suggest a Skill instead
- anything true only of the current conversation
- anything already in memory

**Every memory carries provenance**: source conversation, source message, timestamp, and
the model that extracted it. The inspector lists them with last-used dates and one-click
revoke.

**Injection is budgeted.** Memories go into the system prompt under a token ceiling;
when it is exceeded, entries drop by lowest value — stale before fresh, unused before
used, unpinned before pinned.

---

## Context budget

All three channels compete with conversation history for the model's window. Defaults,
expressed as a share of the active model's context:

| Component | Share | Notes |
|---|---|---|
| System prompt + project instructions | ~2% | fixed |
| Skill index | ~1% | names and descriptions only |
| Loaded skill bodies | up to 10% | on demand, evicted oldest-first |
| Memory | up to 5% | budgeted, ranked |
| Retrieved knowledge | up to 15% | per-turn, not persistent |
| Conversation history | remainder | compacted when squeezed |

The context meter on the composer breaks down by component, so it is always visible which
channel is eating the window.

---

## Web search is not a fourth channel

The three channels describe what Harbor **stores**. Web search stores nothing, so it does
not join the taxonomy — it is a retrieval tool sitting beside `search_knowledge`, one
reaching the open web and the other a corpus you curated.

It runs as OpenRouter's `openrouter:web_search` server tool (the `web` plugin it replaced is deprecated upstream), which keeps the architecture intact: no second
API key, and every request still goes to `openrouter.ai`. It is billed per search on top of
tokens, around $0.007 a request, and that charge does arrive in OpenRouter's `cost` field,
so project spend already accounts for it.

Two things make it different from every other source, and both are handled rather than
assumed away:

- **It is the one context source an attacker can author.** Everything else in Harbor is
  material you chose to add. A web page can contain text aimed at the model, and this agent
  writes files without a gate. So a turn with web search on carries a standing instruction
  that retrieved content is information and never instruction, and any edit made during
  such a run is marked in the Changes pane — those diffs are the ones worth reading closely.
- **Results arrive server-side, not as a tool call.** Without help it would be the only
  context addition Harbor could not show. The `url_citation` annotations are rendered under
  the reply, so what came in is always visible and clickable.

---

## Caching the stable prefix

The three channels share a useful property: they change rarely. The system prompt,
the skill index, loaded skill bodies and the memory block are identical from one turn to
the next, which makes them exactly the stable prefix that provider prompt caching is
designed for. Retrieved knowledge is per-turn and sits after them.

That is worth real money. Reading a cached prompt costs roughly a tenth of the normal
input price on Anthropic and DeepSeek, and a quarter on OpenAI, Gemini and Grok.

Two facts decide how Harbor uses it:

- **Some providers cache on their own** — OpenAI, DeepSeek, Grok, Moonshot, Groq, Z.AI,
  and Gemini 2.5 implicitly. Nothing to do.
- **Others cache only where the request marks a breakpoint** — Anthropic and Qwen need
  `cache_control`, and Gemini supports explicit breakpoints too. On these, caching simply
  does not happen unless Harbor asks for it.

So the prompt is assembled prefix-first — system, skills, memory, then retrieved
knowledge, then history — and a `cache_control` breakpoint goes at the end of the stable
region on providers that need one. Minimums apply (1,024–4,096 tokens depending on the
model), so the breakpoint is only worth setting once the prefix is large enough, which in
practice means once skills and memory are carrying weight.

**Status:** built. The prompt is assembled prefix first — project instructions, skill
index, memory — and on a provider that needs one, a `cache_control` breakpoint is set at
the end of that prefix once it passes roughly 4,200 characters, which is Anthropic's
1,024-token floor. Below that the breakpoint would not be honoured, so it is omitted. The
model picker shows each model's cached-read price and marks whether caching is automatic.

---

## Routing on input

Adding something to a project is one flow, not three. You drop in a file, paste text, or
promote a message, and Harbor asks which channel it is — pre-selecting a guess from shape:

- a folder of documents → Knowledge
- a numbered or step-shaped markdown file → Skill
- a promoted assistant message → Memory

The guess is always overridable. Mis-routing is the main way this model degrades, so the
choice is explicit rather than inferred silently.

---

## Seeing the prompt

Three of the four things in the system prompt are generated — the skill index, the memory
block, and the web caution — so for a while none of them were visible anywhere, and the
context gauge reported only the project's own instructions under the label "System prompt".
On a project with skills and memories but no written instructions it read zero while
sending several hundred tokens.

The gauge now reports the real assembled prompt, band by band, and clicking it opens the
prompt itself: each section, its token cost, and whether a cache breakpoint applied and
why. Assembly lives in one function that both the turn loop and the inspector call, because
a preview that recomputed the prompt separately would drift from what is actually sent, and
an inspector that lies is worse than none.

Instructions come in two layers: global ones in Settings that apply everywhere, then the
project's own.

---

## Where these live in the UI

One sidebar destination, **Context**, opening a three-tab view: **Skills · Knowledge ·
Memory**. Project-scoped by default with a toggle for global. This keeps Zone 1 compact and
mirrors the taxonomy directly, so the mental model and the UI are the same shape.

Prompts stay separate and are not one of the three channels: a prompt is text *you* insert
for yourself, while skills, knowledge, and memory are context the *agent* consumes.
