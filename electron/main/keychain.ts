import { safeStorage } from 'electron'
import { getSetting, setSetting } from './db'

/**
 * The OpenRouter key is encrypted with the macOS Keychain-backed safeStorage and
 * kept in the settings table. It is never written to a file in the source tree and
 * never crosses into the renderer — see "Process split" in the README.
 */
const KEY = 'openrouter_key_encrypted'

export function hasKey(): boolean {
  // clearKey stores an empty string, which is no key.
  return !!getSetting(KEY)
}

export function setKey(plain: string): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Encrypted storage is unavailable on this system.')
  }
  setSetting(KEY, safeStorage.encryptString(plain).toString('base64'))
}

export function clearKey(): void {
  setSetting(KEY, '')
}

/** Main-process only. Returns null when no key is stored. */
export function readKey(): string | null {
  const stored = getSetting(KEY)
  if (!stored) return null
  try {
    return safeStorage.decryptString(Buffer.from(stored, 'base64'))
  } catch {
    return null
  }
}

/** Any other secret kept the same way, under a setting of its own; null when none is stored or it cannot be read. */
export function readSecret(setting: string): string | null {
  const stored = getSetting(setting)
  if (!stored) return null
  try {
    return safeStorage.decryptString(Buffer.from(stored, 'base64'))
  } catch {
    return null
  }
}

export function writeSecret(setting: string, plain: string): void {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Encrypted storage is unavailable on this system.')
  setSetting(setting, safeStorage.encryptString(plain).toString('base64'))
}
