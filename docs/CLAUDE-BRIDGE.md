# Claude Code as a run's orchestrator and judge

Harbor can act as an MCP server, so a Claude Code session can orchestrate and
judge a director run. Harbor, the person and Claude each have one job:

- **Harbor writes.** Its interviewer writes the requirements, its director
  writes the plan, and its workers write the work.
- **The person says what they want.** They answer the interview themselves,
  since that is what the interview exists for, and they answer workers who stop
  to ask something.
- **Claude orchestrates and judges.** It starts the interview with the person's
  brief, starts the director once the requirements are written, approves the
  plan, and keeps the run moving with short nudges. It judges the plan and the
  work against the requirements, and its judgement goes **to the person** as a
  review in the run view. The person decides what reaches the director.

## What Claude cannot do

- **Write the work.** No tool writes a file, and the requirements always come
  from Harbor's interviewer.
- **Answer for the person, unless they allow it.** By default, Claude's attempts
  to answer the interview or a worker's question are refused, and its `wait` on
  an interview holds until the person has finished it in Harbor. Harbor tells
  the person the interview is waiting for them, in the window and with a desktop
  notification. The setting **Claude may answer for me** (Settings →
  Integrations) turns this over to Claude, which then relays the person's
  answers and says a question is open where the person hasn't decided.
- **Send the director its opinions.** A message to a director is a nudge to keep
  the run moving ("continue", "retry T3, it stopped on a failed command") and is
  capped at 600 characters. Anything longer is refused, with a pointer to
  `post_review`.
- **Speak unmarked.** Everything Claude sends an agent begins with a line saying
  it comes from Claude orchestrating the run, to be acted on in the agent's own
  words and never used as text. The person sees the same line.

The bridge can't stop a Claude Code session from editing the project folder
with its own file tools. It is told not to; if you want that enforced, add a
deny rule for the project folders to Claude Code's permissions.

Only director runs are reachable: interviews, directors and their workers.
Ordinary chats are not.

## Reviews

`post_review` takes:

- **a verdict:** *on track*, *needs work* or *off track*;
- **a summary:** how the plan or work stands against the requirements, at most
  2,000 characters;
- **up to ten suggestions:** each at most 1,000 characters, and each naming its
  task where it's about one.

A suggestion says what to change and why, never the changed text.

The newest review sits at the top of the run view, with earlier ones folded
beneath it. Each suggestion has two buttons:

- **Send to director** puts it in the director's message box for you to read,
  edit and send. Claude's words never reach the director on their own.
- **Dismiss** puts it aside.

Claude sees what you did with each suggestion in `run_status`. A new review
shows as a notice with an **Open** button, and as a desktop notification when
Harbor isn't in front.

## Turning it on

1. In Harbor, open Settings, go to Integrations, and tick **Claude Code**.
2. Click **Copy command** and run it once in a terminal. It registers Harbor for
   every folder (`--scope user`), with the token in its header:

   ```bash
   claude mcp add --scope user --transport http harbor http://127.0.0.1:47632/mcp --header "Authorization: Bearer <token>"
   ```

3. In Claude Code, `/mcp` should list `harbor` as connected. Harbor has to be
   running for Claude to reach it.

**New token** makes the old token stop working immediately. Run the new command
to replace the registration: `claude mcp remove harbor` first, then the copied
command.

## A run, orchestrated

1. `list_projects` to find the project. A director needs a folder under git,
   because workers run commands without asking and every change has to be
   visible and reversible.
2. `start_interview` with the person's brief. Tell the person it's waiting for
   them in Harbor, then `wait` until it returns `requirements written`.
3. `start_director` from that interview with a `budget`, then `wait`.
4. Read `requirements`, `design` and `tasks` with `read_run_file`. If the plan
   meets the requirements, `approve_plan`. If it doesn't, `post_review` with
   what's missing and tell the person.
5. `wait` in a loop, nudging with `send_message` when the run stalls. It
   returns when the director's turn ends, or after at most five minutes, in
   which case you call it again.
6. Judge the work: `run_changes` lists every file the run added, changed or
   deleted since it started, and `read_file` reads them. `post_review` with a
   verdict and specific suggestions, and say in your reply what you posted.
7. When the handoff is in, post a final review, then `finish_run` writes
   `run-log.md` and archives the workers.

## The tools

| Tool | What it does |
|---|---|
| `list_projects` | Projects with a folder; archived ones are left out |
| `list_runs` | A project's interviews and directors, newest first |
| `start_interview` | A new interview with the person's brief; the person answers it |
| `start_director` | A director on its own branch, from an interview's requirements |
| `send_message` | A nudge to a director; or answers to an interview, if allowed |
| `approve_plan` | Approves the design and board, and tells the director to begin |
| `answer_question` | Answers a worker's question, if the person allows it |
| `post_review` | A verdict, summary and suggestions, for the person in the run view |
| `run_status` | Approval, money, branch, board, workers, questions, reviews, latest reply |
| `wait` | Blocks until the run needs Claude, or the timeout |
| `run_changes` | Files the run added, changed or deleted since its first commit |
| `read_file` | Reads a file in the project folder, read-only, inside the folder only |
| `read_conversation` | The messages of an interview, director or worker |
| `read_run_file` | `requirements`, `design`, `tasks`, `handoff`, `log` or `guidance` |
| `stop` | Stops the running turn, and a director's workers |
| `finish_run` | Writes the run log and archives the workers |

## What keeps it safe

- It is off until you turn it on, and it listens on 127.0.0.1 only.
- Every request needs the token. The token is stored encrypted with the Keychain.
- Requests from a browser page are refused: any request carrying an `Origin`
  header, or a `Host` that is not this machine, is rejected, which also blocks
  DNS rebinding.
- Every run started this way has a budget, which must be more than zero and no
  more than the cap in Settings ($5 by default). Claude cannot raise a run's
  budget; only you can, from the run's header in the window.
- Runs Claude starts are titled "Director (Claude)" and "Interview (Claude)",
  and every call is logged under `bridge` in Harbor's log.

## Where it lives

- `shared/bridge.ts`: the tools, the note framing and length caps, reviews,
  the Host, Origin and token checks, and the budget rule.
- `electron/main/bridge.ts`: the HTTP server (stateless streamable HTTP from the
  MCP SDK) and the tool handlers.
- `electron/main/db/reviews.ts`: the reviews table (schema 12).
- `electron/main/runs.ts`: the director operations, shared by the window's IPC
  and the bridge.
- `src/components/RunView.tsx`: the run view's review section.
- `test/bridge.cjs`: the real SDK client against the server, with a fake model
  server behind it.
