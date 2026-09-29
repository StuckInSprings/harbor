/**
 * The schemas the model is shown, one per tool, in OpenAI function form.
 * Kept apart from the code that runs them so the wording can be read and
 * edited as prose. Which of these a given turn is offered is decided in
 * index.ts.
 */
import { WORKERS_AT_ONCE } from '../../../shared/director'

export const FILE_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description:
        'Read a text file inside the project folder. Returns the content with line numbers. Use offset and limit for large files.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path relative to the project root.' },
          offset: { type: 'integer', description: 'First line to return, 0-based.' },
          limit: { type: 'integer', description: 'How many lines to return.' }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description: 'List a directory inside the project folder.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory relative to the project root.' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search',
      description:
        'Search the project. Plain text is a case-insensitive substring; wrap in slashes for a regular expression, e.g. /useEffect\\(/g. Set kind to "files" to match path names instead of contents.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          kind: { type: 'string', enum: ['content', 'files'] },
          glob: { type: 'string', description: 'Limit to paths matching this glob, e.g. src/**/*.ts' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description:
        'Create a file or replace its entire contents. The previous version is snapshotted first and can be undone.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' }
        },
        required: ['path', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description:
        'Replace an exact string in a file. old_string must appear exactly once unless replace_all is true. The previous version is snapshotted first.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          old_string: { type: 'string' },
          new_string: { type: 'string' },
          replace_all: { type: 'boolean' }
        },
        required: ['path', 'old_string', 'new_string']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description:
        'Run a shell command in the project folder. The person watching approves it first unless they have allowlisted it, so prefer one clear command over a long chain, and say what it is for in your message.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The command line to run.' },
          timeout_seconds: {
            type: 'integer',
            description: 'How long to wait before giving up. Defaults to 120.'
          },
          unsandboxed: {
            type: 'boolean',
            description:
              'Commands run in a sandbox: writes only inside the project and scratch folders, network only to allowed domains. Set true only when a command was refused by the sandbox and genuinely needs more; the person is always asked before it runs.'
          },
          background: {
            type: 'boolean',
            description:
              'Start it and return at once with a handle, for a server, a watcher or a long build. Read what it prints with command_output, wait there for a line, and end it with stop_command. It keeps running after this turn.'
          }
        },
        required: ['command']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'todo_write',
      description:
        'Publish the checklist for this task so the person watching can follow along. Send the whole list every time. Use it for multi-step work, not for single actions.',
      parameters: {
        type: 'object',
        properties: {
          todos: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                content: { type: 'string' },
                status: { type: 'string', enum: ['pending', 'active', 'done'] }
              },
              required: ['content', 'status']
            }
          }
        },
        required: ['todos']
      }
    }
  }
] as const

export const LOAD_SKILL = {
  type: 'function',
  function: {
    name: 'load_skill',
    description:
      'Read the full procedure for one of the skills listed in your instructions. Load it before following a procedure rather than improvising the steps.',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: 'The skill name from the list.' } },
      required: ['name']
    }
  }
} as const

export const SEARCH_KNOWLEDGE = {
  type: 'function',
  function: {
    name: 'search_knowledge',
    description:
      "Search this project's reference material — documents and notes that were added deliberately, not the code in the working folder. Use it to ground an answer in what is written down. Results are cited; cite them back.",
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        k: { type: 'integer', description: 'How many passages to return. Defaults to 6.' }
      },
      required: ['query']
    }
  }
} as const

export const DISPATCH = {
  type: 'function',
  function: {
    name: 'dispatch',
    description:
      `Brief one or more workers and wait for their reports. Each task becomes its own conversation on the tier's model in this project, with the brief as its first message and the owned paths as the only ones it may change. Returns when every worker is done, with each report. At most ${WORKERS_AT_ONCE} at once, and only tasks whose owned paths do not overlap; the call refuses otherwise.`,
    parameters: {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              task_id: { type: 'string', description: 'The id on the board, e.g. T2.' },
              title: { type: 'string', description: 'The title on the board.' },
              tier: { type: 'string', description: 'A tier from the table in your status; an unknown tier runs on your own model.' },
              owns: { type: 'array', items: { type: 'string' }, description: 'Globs, relative to the project root, of the paths the worker may change. Empty for a task that only reads and reports.' },
              brief: { type: 'string', description: 'The whole brief, written by the guidance: outcome, requirement quoted, files to read, files owned, what to return.' }
            },
            required: ['task_id', 'title', 'tier', 'owns', 'brief']
          }
        }
      },
      required: ['tasks']
    }
  }
}

export const COMMAND_OUTPUT = {
  type: 'function',
  function: {
    name: 'command_output',
    description:
      'What a background command has printed since you last looked. Give wait_for to wait for a line matching a pattern (a regular expression), such as "Listening on|ready|error", up to the timeout; without it, what is there now is returned at once. Says whether the command has ended and how.',
    parameters: {
      type: 'object',
      properties: {
        handle: { type: 'string', description: 'The handle run_command returned.' },
        wait_for: { type: 'string', description: 'A pattern to wait for in the new output.' },
        timeout_seconds: { type: 'integer', description: 'How long to wait for the pattern. Defaults to 60, at most 600.' }
      },
      required: ['handle']
    }
  }
}

export const STOP_COMMAND = {
  type: 'function',
  function: {
    name: 'stop_command',
    description: 'Ends a background command you started.',
    parameters: {
      type: 'object',
      properties: {
        handle: { type: 'string', description: 'The handle run_command returned.' }
      },
      required: ['handle']
    }
  }
}

export const ASK_ORACLE = {
  type: 'function',
  function: {
    name: 'ask_oracle',
    description:
      'Put a question to a second, stronger model and get its opinion back: a review of a plan or a diff, a judgement between two approaches, a check on reasoning you are unsure of. It sees only what you send it — the question and the material you paste in — not this conversation, so include what it needs. Costs a call to that model; use it for decisions that matter, not for lookups.',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'What you want judged, and against what.' },
        material: { type: 'string', description: 'The plan, the diff, the code or the transcript it should read. Optional.' }
      },
      required: ['question']
    }
  }
}

export const FIND_TOOLS = {
  type: 'function',
  function: {
    name: 'find_tools',
    description:
      'Look up tools from the connected MCP servers. Their schemas are not in your context until you find them: give a few words for what you need, read the list, and the tools it names can then be called like any other. An empty query lists everything.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What you want to do, in a few words.' }
      },
      required: []
    }
  }
}

export const DELEGATE = {
  type: 'function',
  function: {
    name: 'delegate',
    description:
      'Hand one task to a worker and wait for its report. The worker is a conversation of its own in this project, with the brief as its first message, its own model and money, and only the paths you name to write to; nothing it reads enters your context, only what it reports. Use it for reading and trial and error that would otherwise fill this conversation: survey a folder and summarise, try a change under a test and report, find where something is defined. Write the brief as if to someone who has read nothing: the outcome, what to read first, what it may change, and what to put in the report. One worker at a time.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'A few words naming the task, for the sidebar.' },
        brief: { type: 'string', description: 'The whole brief.' },
        model: { type: 'string', description: 'A model id for the worker; your own by default. A cheaper one for reading, a stronger one for a hard change.' },
        owns: { type: 'array', items: { type: 'string' }, description: 'Globs, relative to the project root, the worker may write under. Empty means the whole project.' },
        read_only: { type: 'boolean', description: 'The worker may read and run commands but change nothing.' },
        max_spend: { type: 'number', description: 'Dollars the worker may spend before it is stopped. Half a dollar by default, five at most.' }
      },
      required: ['title', 'brief']
    }
  }
}

export const CONTINUE_TASK = {
  type: 'function',
  function: {
    name: 'continue_task',
    description:
      "Send a follow-up to a worker you dispatched — what its report was missing, or a decision it asked for — and wait for its next report. Once per task as a rule; a second failure means the brief or the task is wrong.",
    parameters: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'The id of a task you dispatched.' },
        message: { type: 'string', description: 'What to tell the worker.' }
      },
      required: ['task_id', 'message']
    }
  }
}

/*
  A worker's question to the person. The tool waits — the turn stays open,
  the answer arrives as the tool's result — so a decision that is the
  person's is made by the person, mid-task, and the worker carries on with
  it. The director never sees the question; it was never the director's.
*/
export const ASK_PERSON = {
  type: 'function',
  function: {
    name: 'ask_person',
    description:
      'Ask the person a question only they can answer and wait for the answer; it comes back as this result and the task carries on. What the work is for, which of two readings of the brief is meant, what they would accept: those are theirs, never yours to decide. Show what you have — the line in question, the two readings you are choosing between — and ask one clear question. Ask several things in one call rather than one at a time.',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The question, with just enough of what you have seen for them to answer it without opening files.' }
      },
      required: ['question']
    }
  }
}
