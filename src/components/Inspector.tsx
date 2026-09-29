import { Cross } from './Icons'
import { Changes } from './Changes'
import { Terminal, type TermBlock } from './Terminal'
import { FileView } from './FileView'
import { Explorer } from './Explorer'
import { Progress, type ProgressItem } from './Progress'

export type InspectorMode = 'none' | 'terminal' | 'changes' | 'files' | 'explorer'

const TITLES: Record<Exclude<InspectorMode, 'none'>, string> = {
  terminal: 'Terminal',
  changes: 'Changes',
  files: 'File',
  explorer: 'Explorer'
}

interface Props {
  mode: Exclude<InspectorMode, 'none'>
  conversationId: string | null
  changesTick: number
  blocks: TermBlock[]
  onRunCommand: (command: string) => void
  onKill: (handle: string) => void
  onReverted: () => void
  filePath: string | null
  fileTick: number
  onCloseFile: () => void
  onClose: () => void
  rootPath: string
  rootName: string
  onOpenFile: (path: string) => void
  onAttachFile: (path: string) => void
  /** The agent's checklist for this conversation, kept after the run. */
  progress: ProgressItem[]
  progressLive: boolean
  /** The left edge is a grip: drag to size the pane, double-click to reset. */
  onResizeStart: (e: React.MouseEvent) => void
  onResizeReset: () => void
}

export function Inspector({
  mode,
  conversationId,
  changesTick,
  blocks,
  onRunCommand,
  onKill,
  onReverted,
  filePath,
  fileTick,
  onCloseFile,
  onClose,
  rootPath,
  rootName,
  onOpenFile,
  onAttachFile,
  progress,
  progressLive,
  onResizeStart,
  onResizeReset
}: Props): React.JSX.Element {
  return (
    <aside className="inspector">
      <div
        className="inspector__grip"
        onMouseDown={onResizeStart}
        onDoubleClick={onResizeReset}
        title="Drag to resize; double-click to reset"
      />
      <div className="inspector__head">
        <span className="inspector__title">{TITLES[mode]}</span>
        <button className="icon-btn" onClick={onClose} title="Close panel" aria-label="Close panel">
          <Cross />
        </button>
      </div>
      <Progress items={progress} live={progressLive} />
      <div className="inspector__body" data-flush={mode !== 'changes'}>
        {mode === 'changes' ? (
          <Changes conversationId={conversationId} tick={changesTick} onReverted={onReverted} />
        ) : mode === 'explorer' ? (
          <Explorer
            conversationId={conversationId}
            rootPath={rootPath}
            rootName={rootName}
            reloadToken={changesTick}
            selected={filePath}
            onOpen={onOpenFile}
            onAttach={onAttachFile}
          />
        ) : mode === 'terminal' ? (
          <Terminal
            conversationId={conversationId}
            blocks={blocks}
            onRun={onRunCommand}
            onKill={onKill}
          />
        ) : (
          <FileView
            conversationId={conversationId}
            path={filePath}
            reloadToken={fileTick}
            onClose={onCloseFile}
            onOpen={onOpenFile}
            onAttach={onAttachFile}
            onChanged={onReverted}
          />
        )}
      </div>
    </aside>
  )
}
