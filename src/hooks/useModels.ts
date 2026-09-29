import { useCallback, useEffect, useState } from 'react'
import type { KeyStatus, ModelInfo } from '../../shared/types'
import { unwrap } from '../lib/unwrap'
import { api } from '../lib/api'

const LAST_MODEL = 'last_model'

/**
 * The key and the catalogue it unlocks: the models, the favourites, the one
 * used last. Loaded once the key is known to be present.
 */
export function useModels(opts: { activeId: string | null; refreshConversations: () => Promise<void> }): {
  keyStatus: KeyStatus | null
  hasKey: boolean
  /** Whether anything can be asked: a key for OpenRouter, or a local server with models. */
  canChat: boolean
  models: ModelInfo[]
  favorites: string[]
  modelsLoading: boolean
  modelsError: string | null
  lastModel: string | null
  setLastModel: (id: string) => void
  loadModels: () => Promise<void>
  toggleFavorite: (modelId: string) => Promise<void>
  /** The model chosen from the picker: remembered, and set on the conversation on screen. */
  pickModel: (modelId: string) => Promise<void>
  /** The model a send was made with, remembered as the last. */
  rememberModel: (modelId: string) => Promise<void>
  saveKey: (plain: string) => Promise<string | null>
  clearKey: () => Promise<void>
} {
  const { activeId, refreshConversations } = opts
  const [keyStatus, setKeyStatus] = useState<KeyStatus | null>(null)
  const [models, setModels] = useState<ModelInfo[]>([])
  const [favorites, setFavorites] = useState<string[]>([])
  const [modelsLoading, setModelsLoading] = useState(false)
  const [modelsError, setModelsError] = useState<string | null>(null)
  const [lastModel, setLastModel] = useState<string | null>(null)

  useEffect(() => {
    void (async () => {
      setKeyStatus(unwrap(await api.key.status()))
      setFavorites(unwrap(await api.models.favorites()))
      setLastModel(unwrap(await api.settings.get(LAST_MODEL)))
    })()
  }, [])

  const loadModels = useCallback(async () => {
    setModelsLoading(true)
    setModelsError(null)
    try {
      setModels(unwrap(await api.models.list()))
    } catch (e) {
      setModelsError((e as Error).message)
    } finally {
      setModelsLoading(false)
    }
  }, [])

  // Models are listed once the key is known either way: without one, the local server's are still there.
  useEffect(() => {
    if (keyStatus !== null) void loadModels()
  }, [keyStatus, loadModels])

  const toggleFavorite = useCallback(async (modelId: string): Promise<void> => {
    setFavorites(unwrap(await api.models.toggleFavorite(modelId)))
  }, [])

  const rememberModel = useCallback(async (modelId: string): Promise<void> => {
    await api.settings.set(LAST_MODEL, modelId)
    setLastModel(modelId)
  }, [])

  const pickModel = useCallback(
    async (modelId: string): Promise<void> => {
      await rememberModel(modelId)
      if (activeId) {
        await api.conversations.setModel(activeId, modelId)
        await refreshConversations()
      }
    },
    [activeId, refreshConversations, rememberModel]
  )

  const saveKey = useCallback(async (plain: string): Promise<string | null> => {
    const res = await api.key.set(plain)
    if (!res.ok) return res.error ?? 'That key could not be stored.'
    setKeyStatus(unwrap(await api.key.status()))
    return null
  }, [])

  const clearKey = useCallback(async (): Promise<void> => {
    await api.key.clear()
    setKeyStatus({ present: false })
    setModels([])
  }, [])

  const hasKey = keyStatus?.present === true
  return { keyStatus, hasKey, canChat: hasKey || models.some((m) => m.id.startsWith('local/')), models, favorites, modelsLoading, modelsError, lastModel, setLastModel, loadModels, toggleFavorite, pickModel, rememberModel, saveKey, clearKey }
}
