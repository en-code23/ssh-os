/// <reference types="vite/client" />
import type { Api } from './tauri-bridge'
declare global {
  interface Window {
    api: Api
  }
}
export {}
