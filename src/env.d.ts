/// <reference types="vite/client" />
import type { HarborApi } from '../electron/preload/index'

declare global {
  interface Window {
    harbor: HarborApi
  }
}
export {}
