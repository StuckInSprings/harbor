import * as db from '../db'
import * as runs from '../runs'
import { isRole } from '../../../shared/director'
import { handle, type Ipc } from './shared'

/**
 * Conversations and their messages, as rows; the turn that fills them is in turns.ts.
 */
export function register(_ipc: Ipc): void {
  /* conversations */
  handle('conversations:list', () => db.listConversations())
  handle('conversations:create', (projectId: string, model: string | null, scratch?: boolean, role?: string) => {
    if (role === 'interview') return runs.createInterview(projectId, model)
    return db.createConversation(projectId, model, !!scratch, isRole(role) ? role : 'chat')
  })
  handle('conversations:keep', (id: string) => {
    db.keepConversation(id)
    return true
  })
  handle('conversations:rename', (id: string, title: string) => {
    db.renameConversation(id, title)
    return true
  })
  handle('conversations:setModel', (id: string, model: string) => {
    db.setConversationModel(id, model)
    return true
  })
  handle('conversations:delete', (id: string) => {
    db.deleteConversation(id)
    return true
  })
  handle('conversations:togglePinned', (id: string) => {
    db.togglePinned(id)
    return true
  })

  handle('conversations:setParams', (id: string, params: unknown) => {
    db.setConversationParams(id, params)
    return true
  })
  handle('conversations:setArchived', (id: string, archived: boolean) => {
    db.setArchived(id, archived)
    return true
  })

  /* messages */
  handle('messages:list', (conversationId: string) => db.listMessages(conversationId))
  handle(
    'messages:add',
    (
      conversationId: string,
      parentId: string | null,
      role: any,
      content: string,
      model: string | null,
      atts?: unknown[]
    ) =>
      db.addMessage(conversationId, parentId, role, content, model, {
        attachments: atts && atts.length ? JSON.stringify(atts) : null
      })
  )
  handle('messages:setLeaf', (conversationId: string, messageId: string) => {
    db.setLeaf(conversationId, messageId)
    return true
  })
  handle('messages:delete', (messageId: string) => {
    db.deleteMessage(messageId)
    return true
  })

  /* spending */
  handle('usage:conversations', () => db.conversationCosts())
  handle('usage:projects', () => db.projectCosts())
  handle('usage:daily', (days: number) => db.dailyCosts(days))

}
