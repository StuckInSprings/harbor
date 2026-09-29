import { contextBridge, ipcRenderer } from 'electron'
import type { ConversationRole, RunWorker, Task } from '../../shared/director'
import type { BridgeStatus, Review, SuggestionState } from '../../shared/bridge'
import type {
  FileVersion,
  WorkspaceEntry,
  AllowedCommand,
  Attachment,
  AssembledSystem,
  ApprovalDecision,
  Conversation,
  DailyCost,
  IndexProgress,
  KnowledgeSource,
  LogLine,
  Memory,
  ModelParams,
  Prompt,
  SearchResult,
  KeyStatus,
  Message,
  ModelInfo,
  Project,
  Result,
  Role,
  RunOptions,
  Skill,
  StreamEvent,
  TerminalEvent
} from '../../shared/types'
import type { Checkpoint, TreeSnapshot } from '../../shared/types'

const call = <T>(channel: string, ...args: unknown[]): Promise<Result<T>> =>
  ipcRenderer.invoke(channel, ...args)

/**
 * The renderer's entire capability surface. No Node, no filesystem, no direct
 * network — everything the UI can do is listed here.
 */
const api = {
  key: {
    status: () => call<KeyStatus>('key:status'),
    set: (plain: string) => call<boolean>('key:set', plain),
    clear: () => call<boolean>('key:clear')
  },
  models: {
    list: () => call<ModelInfo[]>('models:list'),
    favorites: () => call<string[]>('models:favorites'),
    toggleFavorite: (modelId: string) => call<string[]>('models:toggleFavorite', modelId)
  },
  projects: {
    list: () => call<Project[]>('projects:list'),
    create: (name: string, rootPath: string | null) =>
      call<Project>('projects:create', name, rootPath),
    update: (id: string, patch: Partial<Project>) => call<boolean>('projects:update', id, patch),
    remove: (id: string) => call<boolean>('projects:delete', id),
    reorder: (ids: string[]) => call<boolean>('projects:reorder', ids),
    setArchived: (id: string, archived: boolean) => call<boolean>('projects:setArchived', id, archived),
    pickRoot: () => call<string | null>('projects:pickRoot'),
    isRepo: (path: string) => call<boolean>('projects:isRepo', path)
  },
  conversations: {
    list: () => call<Conversation[]>('conversations:list'),
    create: (projectId: string, model: string | null, scratch = false, role: ConversationRole = 'chat') =>
      call<Conversation>('conversations:create', projectId, model, scratch, role),
    /** A throwaway the person wants after all. */
    keep: (id: string) => call<boolean>('conversations:keep', id),
    startDirector: (projectId: string, model: string, budget: number, rehearsal = false, fromInterview: string | null = null) =>
      call<Conversation>('conversations:startDirector', projectId, model, budget, rehearsal, fromInterview),
    approve: (id: string) => call<boolean>('conversations:approve', id),
    setBudget: (id: string, budget: number) => call<boolean>('conversations:setBudget', id, budget),
    rename: (id: string, title: string) => call<boolean>('conversations:rename', id, title),
    setModel: (id: string, model: string) => call<boolean>('conversations:setModel', id, model),
    remove: (id: string) => call<boolean>('conversations:delete', id),
    togglePinned: (id: string) => call<boolean>('conversations:togglePinned', id),
    setParams: (id: string, params: ModelParams) =>
      call<boolean>('conversations:setParams', id, params),
    setArchived: (id: string, archived: boolean) =>
      call<boolean>('conversations:setArchived', id, archived)
  },
  messages: {
    list: (conversationId: string) => call<Message[]>('messages:list', conversationId),
    add: (
      conversationId: string,
      parentId: string | null,
      role: Role,
      content: string,
      model: string | null,
      attachments?: Attachment[]
    ) =>
      call<Message>(
        'messages:add',
        conversationId,
        parentId,
        role,
        content,
        model,
        attachments
      ),
    setLeaf: (conversationId: string, messageId: string) =>
      call<boolean>('messages:setLeaf', conversationId, messageId),
    remove: (messageId: string) => call<boolean>('messages:delete', messageId)
  },
  usage: {
    byConversation: () => call<Record<string, number>>('usage:conversations'),
    byProject: () => call<Record<string, number>>('usage:projects'),
    daily: (days: number) => call<DailyCost[]>('usage:daily', days)
  },
  skills: {
    list: (projectId: string | null) => call<Skill[]>('skills:list', projectId),
    save: (projectId: string | null, name: string, description: string, body: string) =>
      call<Skill>('skills:save', projectId, name, description, body),
    remove: (projectId: string | null, name: string) =>
      call<boolean>('skills:delete', projectId, name)
  },
  knowledge: {
    sources: (projectId: string) => call<KnowledgeSource[]>('knowledge:sources', projectId),
    pick: () => call<string[]>('knowledge:pick'),
    add: (projectId: string, path: string) =>
      call<KnowledgeSource>('knowledge:add', projectId, path),
    reindex: (sourceId: string, projectId: string, path: string) =>
      call<boolean>('knowledge:reindex', sourceId, projectId, path),
    remove: (sourceId: string) => call<boolean>('knowledge:remove', sourceId),
    hasVectorSearch: () => call<boolean>('knowledge:vectorSearch'),
    onProgress: (handler: (p: IndexProgress) => void) => {
      const listener = (_e: unknown, payload: IndexProgress): void => handler(payload)
      ipcRenderer.on('knowledge:progress', listener)
      return (): void => {
        ipcRenderer.removeListener('knowledge:progress', listener)
      }
    }
  },
  memory: {
    list: (projectId: string) => call<Memory[]>('memory:list', projectId),
    add: (projectId: string, text: string) => call<Memory>('memory:add', projectId, text),
    setEnabled: (memId: string, enabled: boolean) =>
      call<boolean>('memory:setEnabled', memId, enabled),
    setPinned: (memId: string, pinned: boolean) => call<boolean>('memory:setPinned', memId, pinned),
    review: (memId: string, keep: boolean) => call<boolean>('memory:review', memId, keep),
    remove: (memId: string) => call<boolean>('memory:remove', memId)
  },
  context: {
    system: (projectId: string | null, model: string, web: boolean, plan: boolean) =>
      call<AssembledSystem>('context:system', projectId, model, web, plan)
  },
  menu: {
    show: (kind: 'conversation' | 'project' | 'message' | 'selection', state?: Record<string, unknown>) =>
      call<string | null>('menu:show', { kind, state })
  },
  director: {
    status: (id: string) => call<{ budget: number; approved: boolean; spent: number; branch: string | null; base: string | null } | null>('director:status', id),
    board: (id: string) => call<Task[]>('director:board', id),
    workers: (id: string) => call<RunWorker[]>('director:workers', id),
    /** Write the run log and put the workers away. */
    finish: (id: string) => call<{ path: string; workers: number }>('director:finish', id)
  },
  dialog: {
    confirm: (message: string, detail: string, ok: string) => call<boolean>('dialog:confirm', message, detail, ok)
  },
  attachments: {
    pick: () => call<Attachment[]>('attachments:pick'),
    ingestData: (name: string, mime: string, base64: string) =>
      call<Attachment>('attachments:ingestData', name, mime, base64),
    read: (hash: string) => call<string | null>('attachments:read', hash),
    fromProject: (conversationId: string, path: string) =>
      call<Attachment>('attachments:fromProject', conversationId, path)
  },
  log: {
    recent: () => call<LogLine[]>('log:recent'),
    path: () => call<string>('log:path'),
    reveal: () => call<boolean>('log:reveal'),
    write: (level: 'info' | 'warn' | 'error', scope: string, message: string) =>
      call<boolean>('log:write', level, scope, message),
    onLine: (handler: (line: LogLine) => void) => {
      const listener = (_e: unknown, payload: LogLine): void => handler(payload)
      ipcRenderer.on('log:line', listener)
      return (): void => {
        ipcRenderer.removeListener('log:line', listener)
      }
    }
  },
  search: {
    all: (query: string) => call<SearchResult[]>('search:all', query)
  },
  prompts: {
    list: (projectId: string | null) => call<Prompt[]>('prompts:list', projectId),
    save: (promptId: string | null, projectId: string | null, name: string, body: string) =>
      call<Prompt>('prompts:save', promptId, projectId, name, body),
    remove: (promptId: string) => call<boolean>('prompts:delete', promptId)
  },
  settings: {
    get: (key: string) => call<string | null>('settings:get', key),
    set: (key: string, value: string) => call<boolean>('settings:set', key, value)
  },
  checkpoints: {
    list: (conversationId: string) => call<Checkpoint[]>('checkpoints:list', conversationId),
    diff: (checkpointId: string) =>
      call<{ path: string; before: string | null; after: string | null }>(
        'checkpoints:diff',
        checkpointId
      ),
    undo: (conversationId: string, checkpointId: string) =>
      call<boolean>('checkpoints:undo', conversationId, checkpointId),
    history: (conversationId: string, path: string) =>
      call<FileVersion[]>('checkpoints:history', conversationId, path),
    blob: (hash: string) => call<string | null>('checkpoints:blob', hash),
    restore: (conversationId: string, path: string, hash: string) =>
      call<boolean>('checkpoints:restore', conversationId, path, hash),
    saveAs: (conversationId: string, path: string, hash: string, newPath: string) =>
      call<boolean>('checkpoints:saveAs', conversationId, path, hash, newPath),
    revertRun: (conversationId: string, runId: string) =>
      call<number>('checkpoints:revertRun', conversationId, runId)
  },
  snapshots: {
    list: (conversationId: string) => call<TreeSnapshot[]>('snapshots:list', conversationId),
    changes: (conversationId: string, fromId: string, toId: string) =>
      call<{ status: string; path: string }[]>('snapshots:changes', conversationId, fromId, toId),
    restore: (conversationId: string, snapshotId: string) => call<boolean>('snapshots:restore', conversationId, snapshotId)
  },
  workspace: {
    read: (conversationId: string, path: string) =>
      call<string>('workspace:read', conversationId, path),
    list: (conversationId: string, path: string) =>
      call<string>('workspace:list', conversationId, path),
    tree: (conversationId: string, path: string) =>
      call<WorkspaceEntry[]>('workspace:tree', conversationId, path),
    write: (conversationId: string, path: string, content: string) =>
      call<boolean>('workspace:write', conversationId, path, content),
    readImage: (conversationId: string, path: string) =>
      call<{ mime: string; base64: string }>('workspace:readImage', conversationId, path)
  },
  commands: {
    decide: (approvalId: string, decision: ApprovalDecision) =>
      call<boolean>('commands:decide', approvalId, decision),
    allowed: (projectId: string) => call<AllowedCommand[]>('commands:allowed', projectId),
    forget: (rowId: string) => call<boolean>('commands:forget', rowId),
    kill: (handle: string) => call<boolean>('commands:kill', handle),
    runFromTerminal: (conversationId: string, command: string) =>
      call<boolean>('commands:runFromTerminal', conversationId, command),
    onEvent: (handler: (e: TerminalEvent) => void) => {
      const listener = (_e: unknown, payload: TerminalEvent): void => handler(payload)
      ipcRenderer.on('terminal:event', listener)
      return (): void => {
        ipcRenderer.removeListener('terminal:event', listener)
      }
    }
  },
  chat: {
    run: (requestId: string, opts: RunOptions) => call<boolean>('chat:run', requestId, opts),
    cancel: (requestId: string) => call<boolean>('chat:cancel', requestId),
    aside: (conversationId: string, messageId: string, question: string) =>
      call<{ content: string; cost: number; model: string }>('chat:aside', conversationId, messageId, question),
    compact: (conversationId: string, model: string, contextLength: number) =>
      call<{ summaryId: string; leafId: string; summarised: number; kept: number }>(
        'chat:compact',
        conversationId,
        model,
        contextLength
      ),
    onEvent: (handler: (e: StreamEvent & { owner?: string }) => void) => {
      const listener = (_e: unknown, payload: StreamEvent & { owner?: string }): void => handler(payload)
      ipcRenderer.on('chat:event', listener)
      return (): void => {
        ipcRenderer.removeListener('chat:event', listener)
      }
    }
  },
  openExternal: (url: string) => call<boolean>('shell:openExternal', url),
  /** The launcher panel: applications by name, opened or brought forward. */
  goal: {
    set: (conversationId: string, text: string, budget: number) => call<import('../../shared/types').Conversation | null>('goal:set', conversationId, text, budget),
    clear: (conversationId: string) => call<boolean>('goal:clear', conversationId)
  },
  mcp: {
    status: () => call<{ servers: { name: string; transport: string; enabled: boolean; trusted: boolean; connected: boolean; tools: number; error: string | null }[]; error: string | null }>('mcp:status'),
    reconnect: () => call<{ servers: { name: string; transport: string; enabled: boolean; trusted: boolean; connected: boolean; tools: number; error: string | null }[]; error: string | null }>('mcp:reconnect')
  },
  bridge: {
    status: () => call<BridgeStatus>('bridge:status'),
    configure: (change: { enabled?: boolean; port?: number; cap?: number; answers?: boolean }) => call<BridgeStatus>('bridge:configure', change),
    newToken: () => call<BridgeStatus>('bridge:newToken')
  },
  reviews: {
    list: (conversationId: string) => call<Review[]>('reviews:list', conversationId),
    setState: (reviewId: string, index: number, state: SuggestionState) => call<Review | null>('reviews:setState', reviewId, index, state)
  },
  launcher: {
    query: (text: string) => call<{ path: string; name: string; icon: string; hint?: string }[]>('launcher:query', text),
    open: (path: string, text?: string) => call<void>('launcher:open', path, text),
    forget: (path: string) => call<boolean>('launcher:forget', path),
    resetRanking: () => call<boolean>('launcher:resetRanking'),
    sensitivity: () => call<string>('launcher:sensitivity'),
    setSensitivity: (value: string) => call<boolean>('launcher:setSensitivity', value),
    clips: () => call<{ id: number; text: string; at: number }[]>('launcher:clips'),
    pasteClip: (id: number) => call<boolean>('launcher:pasteClip', id),
    hide: () => call<boolean>('launcher:hide'),
    resize: (height: number) => call<boolean>('launcher:resize', height),
    hotkey: () => call<{ hotkey: string; bound: string | null }>('launcher:hotkey'),
    setHotkey: (hotkey: string) => call<boolean>('launcher:setHotkey', hotkey),
    favourites: () => call<string>('launcher:favourites'),
    setFavourites: (text: string) => call<boolean>('launcher:setFavourites', text),
    onShow: (handler: () => void) => {
      const listener = (): void => handler()
      ipcRenderer.on('launcher:show', listener)
      return (): void => {
        ipcRenderer.removeListener('launcher:show', listener)
      }
    }
  },
  /** This conversation in its own small window that stays above the others. */
  popOut: (conversationId: string) => call<boolean>('ui:popOut', conversationId),
  isPoppedOut: (conversationId: string) => call<boolean>('ui:isPoppedOut', conversationId),
  /** The quick-question hotkey was pressed anywhere on the desktop; from the launcher, the question comes with it. */
  onQuickQuestion: (handler: (question?: string) => void) => {
    const listener = (_e: unknown, question?: string): void => handler(typeof question === 'string' ? question : undefined)
    ipcRenderer.on('ui:quickQuestion', listener)
    return (): void => {
      ipcRenderer.removeListener('ui:quickQuestion', listener)
    }
  },
  /** A command from the menu bar, one word: 'new', 'search', 'settings', 'terminal' and the rest. */
  onCommand: (handler: (command: string) => void) => {
    const listener = (_e: unknown, command: string): void => handler(command)
    ipcRenderer.on('ui:command', listener)
    return (): void => {
      ipcRenderer.removeListener('ui:command', listener)
    }
  },
  /** The launcher picked a project with no conversation in it yet. */
  onNewConversationIn: (handler: (projectId: string) => void) => {
    const listener = (_e: unknown, projectId: string): void => handler(projectId)
    ipcRenderer.on('ui:newConversationIn', listener)
    return (): void => {
      ipcRenderer.removeListener('ui:newConversationIn', listener)
    }
  },
  /** A pop-out window closed on this conversation. */
  onPopClosed: (handler: (conversationId: string) => void) => {
    const listener = (_e: unknown, id: string): void => handler(id)
    ipcRenderer.on('ui:popClosed', listener)
    return (): void => {
      ipcRenderer.removeListener('ui:popClosed', listener)
    }
  },
  /** Something outside the window (the bridge) started a run or sent a message: the list should be read again. */
  onConversationsChanged: (handler: () => void) => {
    const listener = (): void => handler()
    ipcRenderer.on('conversations:changed', listener)
    return (): void => {
      ipcRenderer.removeListener('conversations:changed', listener)
    }
  },
  /** The bridge has something for the person: an interview waiting on them, or Claude's review of a run. */
  onBridgeNotice: (handler: (n: { text: string; conversationId: string; kind: 'interview' | 'review' }) => void) => {
    const listener = (_e: unknown, n: { text: string; conversationId: string; kind: 'interview' | 'review' }): void => handler(n)
    ipcRenderer.on('bridge:notice', listener)
    return (): void => {
      ipcRenderer.removeListener('bridge:notice', listener)
    }
  },
  /** A desktop notification was clicked: show this conversation. */
  onOpenConversation: (handler: (conversationId: string) => void) => {
    const listener = (_e: unknown, id: string): void => handler(id)
    ipcRenderer.on('ui:openConversation', listener)
    return (): void => {
      ipcRenderer.removeListener('ui:openConversation', listener)
    }
  },
  onAppError: (handler: (message: string) => void) => {
    const listener = (_e: unknown, message: string): void => handler(message)
    ipcRenderer.on('app:error', listener)
    return (): void => {
      ipcRenderer.removeListener('app:error', listener)
    }
  }
}

contextBridge.exposeInMainWorld('harbor', api)

export type HarborApi = typeof api
