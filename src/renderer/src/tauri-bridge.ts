/**
 * Provides `window.api` (the interface the UI was written against) on top of Tauri:
 * IPC calls, events, native file drops, window controls and the auto-updater.
 */
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { check, type Update } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'

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

// ---------------- updater ----------------
interface UpdateState {
  status: string
  current: string
  version?: string
  notes?: string
  progress?: number
  error?: string
  checkedAt?: number
}
let upd: UpdateState = { status: import.meta.env.DEV ? 'unsupported' : 'idle', current: '' }
let pending: Update | null = null
let downloaded = false
const setUpd = (p: Partial<UpdateState>) => {
  upd = { ...upd, ...p }
  emitLocal('update:state', upd)
}

async function checkUpdate() {
  if (upd.status === 'unsupported' || upd.status === 'downloading') return
  setUpd({ status: 'checking', error: undefined })
  try {
    pending = await check({ timeout: 20000 })
    if (pending) setUpd({ status: 'available', version: pending.version, notes: pending.body ?? undefined, checkedAt: Date.now() })
    else setUpd({ status: 'not-available', checkedAt: Date.now() })
  } catch (e: any) {
    setUpd({ status: 'error', error: String(e?.message ?? e) })
  }
}

async function downloadUpdate() {
  if (!pending || upd.status === 'downloading' || downloaded) return
  let total = 0
  let done = 0
  setUpd({ status: 'downloading', progress: 0 })
  try {
    await pending.download((ev) => {
      if (ev.event === 'Started') total = ev.data.contentLength ?? 0
      else if (ev.event === 'Progress') {
        done += ev.data.chunkLength
        if (total) setUpd({ progress: done / total })
      }
    })
    downloaded = true
    setUpd({ status: 'downloaded', progress: 1 })
  } catch (e: any) {
    setUpd({ status: 'error', error: String(e?.message ?? e) })
  }
}

async function installUpdate() {
  if (!pending || !downloaded) return
  await pending.install()
  await relaunch()
}

async function autoUpdate() {
  try {
    const s = await invoke<any>('ipc', { channel: 'settings:get', args: [] })
    if (s?.autoCheckUpdates === false) return
    await checkUpdate()
    if (upd.status === 'available' && s?.autoDownloadUpdates !== false) await downloadUpdate()
  } catch { /* offline */ }
}

// ---------------- calls ----------------
async function call(channel: string, ...args: unknown[]): Promise<any> {
  switch (channel) {
    case 'update:state':
      return upd
    case 'update:check':
      return checkUpdate()
    case 'update:download':
      return downloadUpdate()
    case 'update:install':
      return installUpdate()
  }
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
  invoke<any>('ipc', { channel: 'app:info', args: [] })
    .then((i) => setUpd({ current: i.version }))
    .catch(() => {})
  setTimeout(autoUpdate, 8000)
  setInterval(autoUpdate, 6 * 60 * 60 * 1000)
}
