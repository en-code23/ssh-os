/**
 * Provides `window.api` (the interface the UI was written against) on top of Tauri:
 * IPC calls, events, native file drops, window controls and the auto-updater.
 */
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { getCurrentWebview } from '@tauri-apps/api/webview'

type Cb = (payload: any) => void

const ua = navigator.userAgent
const platform = /Mac/i.test(ua) ? 'darwin' : /Windows/i.test(ua) ? 'win32' : 'linux'

// ---------------- events (Tauri events + locally emitted ones) ----------------
const local = new Map<string, Set<Cb>>()
function emitLocal(channel: string, payload: unknown) {
  local.get(channel)?.forEach((cb) => cb(payload))
}
function on(channel: string, cb: Cb) {
  let set = local.get(channel)
  if (!set) local.set(channel, (set = new Set()))
  set.add(cb)
  let unlisten: (() => void) | null = null
  let dead = false
  listen(channel, (e) => cb(e.payload)).then((u) => (dead ? u() : (unlisten = u)))
  return () => {
    dead = true
    set!.delete(cb)
    unlisten?.()
  }
}

// ---------------- updater (implemented in Rust: src-tauri/src/updater.rs) ----------------
async function autoUpdate() {
  try {
    const s = await invoke<any>('ipc', { channel: 'settings:get', args: [] })
    if (s?.autoCheckUpdates === false) return
    await invoke('ipc', { channel: 'update:check', args: [] })
    const u = await invoke<any>('ipc', { channel: 'update:state', args: [] })
    if (u?.status === 'available' && s?.autoDownloadUpdates !== false) await invoke('ipc', { channel: 'update:download', args: [] })
  } catch { /* offline */ }
}

// ---------------- calls ----------------
async function call(channel: string, ...args: unknown[]): Promise<any> {
  try {
    return await invoke('ipc', { channel, args })
  } catch (e) {
    throw new Error(typeof e === 'string' ? e : (e as any)?.message ?? String(e))
  }
}

// ---------------- native file drops ----------------
// Tauri delivers OS file drops with real paths. Re-dispatch them as DOM drag events
// carrying placeholder File objects, and map those back to paths in pathForFile().
const filePaths = new WeakMap<File, string>()
function pathForFile(f: File) {
  return filePaths.get(f) ?? ''
}
function dispatchDrag(type: string, x: number, y: number, paths: string[] = []) {
  const el = document.elementFromPoint(x, y)
  if (!el) return
  const dt = new DataTransfer()
  for (const p of paths) {
    const f = new File([], p.split(/[\\/]/).pop() || 'file')
    filePaths.set(f, p)
    dt.items.add(f)
  }
  el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer: dt }))
}
let dragEl: Element | null = null

function setupWindow() {
  const win = getCurrentWindow()
  const webview = getCurrentWebview()
  webview
    .onDragDropEvent((ev) => {
      const p = ev.payload as any
      const dpr = window.devicePixelRatio || 1
      const x = (p.position?.x ?? 0) / dpr
      const y = (p.position?.y ?? 0) / dpr
      if (p.type === 'enter' || p.type === 'over') {
        const el = document.elementFromPoint(x, y)
        if (el !== dragEl) {
          if (dragEl) dragEl.dispatchEvent(new DragEvent('dragleave', { bubbles: true, relatedTarget: el }))
          dragEl = el
          dispatchDrag('dragenter', x, y)
        }
        dispatchDrag('dragover', x, y)
      } else if (p.type === 'drop') {
        dragEl = null
        dispatchDrag('drop', x, y, p.paths ?? [])
      } else if (p.type === 'leave') {
        dragEl?.dispatchEvent(new DragEvent('dragleave', { bubbles: true }))
        dragEl = null
      }
    })
    .catch(() => {})
  let fs = false
  win
    .onResized(async () => {
      const now = await win.isFullscreen().catch(() => false)
      if (now !== fs) {
        fs = now
        emitLocal('app:fullscreen', fs)
      }
    })
    .catch(() => {})
}

const api = {
  call,
  on,
  termWrite: (id: string, data: string) => {
    invoke('term_write', { id, data }).catch(() => {})
  },
  termResize: (id: string, cols: number, rows: number) => {
    invoke('term_resize', { id, cols, rows }).catch(() => {})
  },
  pathForFile,
  platform,
  win: {
    minimize: () => getCurrentWindow().minimize(),
    toggleMaximize: () => getCurrentWindow().toggleMaximize(),
    close: () => getCurrentWindow().close(),
  },
}

export type Api = typeof api
;(window as any).api = api
setupWindow()
const syncVisible = () => document.documentElement.classList.toggle('page-visible', document.visibilityState === 'visible')
syncVisible()
document.addEventListener('visibilitychange', syncVisible)
if (!import.meta.env.DEV) {
  setTimeout(autoUpdate, 8000)
  setInterval(autoUpdate, 6 * 60 * 60 * 1000)
}
