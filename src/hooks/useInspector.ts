import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import type { InspectorMode } from '../components/Inspector'
import { setFileOpener } from '../lib/fileLinks'
import { api } from '../lib/api'

const INSPECTOR_DEFAULT_W = 380
/** Never narrower than a readable pane, never more than the window can spare. */
const clampInspector = (w: number): number =>
  Math.round(Math.min(Math.max(w, 300), Math.max(300, window.innerWidth - 760)))

/**
 * The right-hand pane: which mode it shows, the file open in it, and its
 * width, which is the person's to set since the editor lives there and a
 * file wants more room than a terminal.
 */
export function useInspector(): {
  inspector: InspectorMode
  setInspector: Dispatch<SetStateAction<InspectorMode>>
  toggleInspector: (mode: Exclude<InspectorMode, 'none'>) => void
  filePath: string | null
  fileTick: number
  /** Open a file in the pane, in front of whatever it showed. */
  openFile: (path: string) => void
  /** Show a file the agent wrote, without seizing a pane that is showing something else. */
  showWritten: (path: string) => void
  unreviewed: boolean
  setUnreviewed: (on: boolean) => void
  inspectorWidth: number
  resizing: boolean
  beginResize: (e: React.MouseEvent) => void
  resetResize: () => void
} {
  const [inspector, setInspector] = useState<InspectorMode>('none')
  const [filePath, setFilePath] = useState<string | null>(null)
  const [fileTick, setFileTick] = useState(0)
  const [unreviewed, setUnreviewed] = useState(false)
  const [inspectorWidth, setInspectorWidth] = useState(INSPECTOR_DEFAULT_W)
  const [resizing, setResizing] = useState(false)

  useEffect(() => {
    void (async () => {
      const r = await api.settings.get('inspector_width')
      const n = r.ok && r.data ? Number(r.data) : NaN
      if (Number.isFinite(n)) setInspectorWidth(clampInspector(n))
    })()
  }, [])

  // Dragged from its left edge, kept in settings, reset with a double-click.
  const widthRef = useRef(INSPECTOR_DEFAULT_W)
  widthRef.current = inspectorWidth
  const beginResize = useCallback((e: React.MouseEvent): void => {
    e.preventDefault()
    const startX = e.clientX
    const startW = widthRef.current
    let latest = startW
    setResizing(true)
    const move = (ev: MouseEvent): void => {
      latest = clampInspector(startW + (startX - ev.clientX))
      setInspectorWidth(latest)
    }
    const up = (): void => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      setResizing(false)
      void api.settings.set('inspector_width', String(latest))
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }, [])
  const resetResize = useCallback((): void => {
    setInspectorWidth(INSPECTOR_DEFAULT_W)
    void api.settings.set('inspector_width', String(INSPECTOR_DEFAULT_W))
  }, [])

  const toggleInspector = useCallback((mode: Exclude<InspectorMode, 'none'>): void => setInspector((m) => (m === mode ? 'none' : mode)), [])
  const openFile = useCallback((path: string): void => {
    setFilePath(path)
    setFileTick((n) => n + 1)
    setInspector('files')
  }, [])
  const showWritten = useCallback((path: string): void => {
    setFilePath(path)
    setFileTick((n) => n + 1)
    setInspector((mode) => (mode === 'none' || mode === 'files' ? 'files' : mode))
  }, [])

  /*
    Clicking a path anywhere in a transcript opens it in the inspector. The
    handler is registered once because markdown is rendered in several places.
  */
  useEffect(() => {
    setFileOpener((path) => {
      setFilePath(path)
      setInspector('files')
    })
  }, [])

  return { inspector, setInspector, toggleInspector, filePath, fileTick, openFile, showWritten, unreviewed, setUnreviewed, inspectorWidth, resizing, beginResize, resetResize }
}
