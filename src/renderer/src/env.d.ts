/// <reference types="vite/client" />
import type { VibeApi } from '../../shared/types'

declare global {
  interface Window {
    vibe: VibeApi
  }
}


export {}
