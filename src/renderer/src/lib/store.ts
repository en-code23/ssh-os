import { create } from 'zustand'
import type { ConnectionState, ServerConfig, Settings, Transfer } from '../../../shared/types'
import { DEFAULT_SETTINGS } from '../../../shared/types'
import { api, Item, uid, UpdateState } from './api'
import { forgetHost, scanHost } from './mc/store'
import { forgetTrHost, scanTrHost } from './tr/store'

export type AppId =
  | 'finder'
  | 'terminal'
  | 'servers'
  | 'monitor'
  | 'editor'
  | 'console'
  | 'network'
  | 'shortcuts'
  | 'settings'
  | 'about'
  | 'quicklook'
  | 'info'
  | 'minecraft'
  | 'terraria'
  | 'codex'

export interface Win {
  id: string
  app: AppId
  title: string
  x: number
  y: number
  w: number
  h: number
  z: number
  minimized: boolean
  maximized: boolean
  serverId?: string
  props: Record<string, any>
  /** shows a dot in the close button */
  dirty?: boolean
}

export interface Toast {
  id: string
  title: string
  body?: string
  kind?: 'info' | 'error' | 'success'
  action?: { label: string; run: () => void }
}

interface DialogReq {
  id: string
  kind: 'prompt' | 'confirm' | 'password'
  title: string
  message?: string
  defaultValue?: string
  okLabel?: string
  destructive?: boolean
  resolve: (v: any) => void
}

interface State {
  servers: ServerConfig[]
  conns: Record<string, ConnectionState>
  activeServerId?: string
  settings: Settings
  windows: Win[]
  focusedId?: string
  zTop: number
  transfers: Transfer[]
  toasts: Toast[]
  dialogs: DialogReq[]
  spotlight: boolean
  clipboard?: { serverId: string; items: Item[]; cut: boolean }
  fullscreen: boolean
  update?: UpdateState
}

export const useStore = create<State>(() => ({
  servers: [],
  conns: {},
  settings: DEFAULT_SETTINGS,
  windows: [],
  zTop: 10,
  transfers: [],
  toasts: [],
  dialogs: [],
  spotlight: false,
  fullscreen: false,
}))

const set = useStore.setState
const get = useStore.getState

// ---------------- windows ----------------
const DEFAULT_SIZES: Partial<Record<AppId, [number, number]>> = {
  finder: [920, 560],
  terminal: [760, 480],
  servers: [860, 560],
  monitor: [880, 580],
  editor: [900, 620],
  console: [880, 540],
  network: [720, 520],
  shortcuts: [760, 520],
  settings: [680, 520],
  about: [360, 380],
  quicklook: [720, 540],
  info: [320, 520],
  minecraft: [1180, 740],
  terraria: [1180, 740],
  codex: [820, 660],
}

const SINGLETONS: AppId[] = ['servers', 'settings', 'about', 'shortcuts']

export function openWindow(app: AppId, opts: { serverId?: string; title?: string; props?: Record<string, any>; forceNew?: boolean } = {}) {
  const s = get()
  if (SINGLETONS.includes(app) && !opts.forceNew) {
    const existing = s.windows.find((w) => w.app === app)
    if (existing) {
      if (opts.props) updateWindow(existing.id, { props: { ...existing.props, ...opts.props } })
      focusWindow(existing.id)
      return existing.id
    }
  }
  const [w, h] = DEFAULT_SIZES[app] ?? [800, 520]
  const vw = window.innerWidth
  const vh = window.innerHeight - 28 - 90
  const n = s.windows.length % 8
  const x = Math.max(10, Math.min(vw - w - 10, (vw - w) / 2 + n * 26 - 80))
  const y = Math.max(36, Math.min(vh - h + 28, 28 + (vh - h) / 2 + n * 26 - 60))
  const id = uid()
  const z = s.zTop + 1
  set({
    windows: [
      ...s.windows,
      {
        id,
        app,
        title: opts.title ?? '',
        x,
        y,
        w: Math.min(w, vw - 20),
        h: Math.min(h, vh),
        z,
        minimized: false,
        maximized: false,
        serverId: opts.serverId,
        props: opts.props ?? {},
      },
    ],
    zTop: z,
    focusedId: id,
  })
  return id
}

export function closeWindow(id: string) {
  const s = get()
  const rest = s.windows.filter((w) => w.id !== id)
  const top = rest.filter((w) => !w.minimized).sort((a, b) => b.z - a.z)[0]
  set({ windows: rest, focusedId: top?.id })
}

export function focusWindow(id: string) {
  const s = get()
  const w = s.windows.find((x) => x.id === id)
  if (!w) return
  if (s.focusedId === id && w.z === s.zTop && !w.minimized) return
  const z = s.zTop + 1
  set({
    zTop: z,
    focusedId: id,
    windows: s.windows.map((x) => (x.id === id ? { ...x, z, minimized: false } : x)),
    activeServerId: w.serverId ?? s.activeServerId,
  })
}

export function updateWindow(id: string, patch: Partial<Win>) {
  set((s) => ({ windows: s.windows.map((w) => (w.id === id ? { ...w, ...patch } : w)) }))
}

export function minimizeWindow(id: string) {
  updateWindow(id, { minimized: true })
  const s = get()
  const top = s.windows.filter((w) => !w.minimized).sort((a, b) => b.z - a.z)[0]
  set({ focusedId: top?.id })
}

export function toggleMaximize(id: string) {
  const w = get().windows.find((x) => x.id === id)
  if (w) updateWindow(id, { maximized: !w.maximized })
}

// ---------------- toasts & dialogs ----------------
export function toast(t: Omit<Toast, 'id'>) {
  const id = uid()
  set((s) => ({ toasts: [...s.toasts, { ...t, id }].slice(-4) }))
  setTimeout(() => dismissToast(id), t.kind === 'error' ? 8000 : 4500)
}
export function dismissToast(id: string) {
  set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
}

function dialog<T>(d: Omit<DialogReq, 'id' | 'resolve'>): Promise<T> {
  return new Promise((resolve) => {
    const id = uid()
    set((s) => ({
      dialogs: [
        ...s.dialogs,
        {
          ...d,
          id,
          resolve: (v: T) => {
            set((st) => ({ dialogs: st.dialogs.filter((x) => x.id !== id) }))
            resolve(v)
          },
        },
      ],
    }))
  })
}

export const prompt = (title: string, defaultValue = '', message?: string, okLabel = 'OK', destructive = false) =>
  dialog<string | null>({ kind: 'prompt', title, defaultValue, message, okLabel, destructive })
export const confirm = (title: string, message?: string, okLabel = 'OK', destructive = false) =>
  dialog<boolean>({ kind: 'confirm', title, message, okLabel, destructive })
export const askPassword = (title: string, message?: string) =>
  dialog<{ password: string; remember: boolean } | null>({ kind: 'password', title, message, okLabel: 'Connect' })

// ---------------- servers & connections ----------------
export async function refreshServers() {
  set({ servers: await api.servers.list() })
}

export function serverName(id?: string) {
  return get().servers.find((s) => s.id === id)?.name ?? 'Server'
}

export function isConnected(id?: string) {
  return !!id && get().conns[id]?.status === 'connected'
}

const pending = new Map<string, Promise<boolean>>()

/** Connects (prompting for password if needed). Resolves true when connected. */
export function ensureConnected(id: string): Promise<boolean> {
  if (isConnected(id)) return Promise.resolve(true)
  const existing = pending.get(id)
  if (existing) return existing
  const p = (async () => {
    const server = get().servers.find((s) => s.id === id)
    if (!server) return false
    let opts: { password?: string; remember?: boolean } | undefined
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await api.conn.connect(id, opts)
        set({ activeServerId: id })
        return true
      } catch (e: any) {
        if (e.message === 'NEED_PASSWORD' || (/Authentication failed/.test(e.message) && server.authMethod === 'password')) {
          const r = await askPassword(
            server.authMethod === 'key' ? `Enter the passphrase for your key` : `Enter your password for “${server.name}”`,
            attempt > 0 ? 'The password was incorrect. Try again.' : `${server.username}@${server.host}`,
          )
          if (!r) return false
          opts = r
          continue
        }
        toast({ title: `Couldn't connect to ${server.name}`, body: e.message, kind: 'error' })
        return false
      }
    }
    return false
  })().finally(() => pending.delete(id))
  pending.set(id, p)
  return p
}

export async function disconnectServer(id: string) {
  await api.conn.disconnect(id)
}

/** Pick a server for a new window: active one, else first connected, else undefined */
export function pickServer(requireExec = false): string | undefined {
  const s = get()
  const ok = (id?: string) =>
    !!id && s.conns[id]?.status === 'connected' && (!requireExec || s.servers.find((x) => x.id === id)?.protocol === 'ssh')
  if (ok(s.activeServerId)) return s.activeServerId
  return Object.keys(s.conns).find((id) => ok(id))
}

// ---------------- init ----------------
export async function init() {
  const [servers, settings, states] = await Promise.all([api.servers.list(), api.settings.get(), api.conn.states()])
  set({
    servers,
    settings: { ...DEFAULT_SETTINGS, ...(settings ?? {}) },
    conns: Object.fromEntries(states.map((c) => [c.serverId, c])),
  })
  for (const c of states) if (c.status === 'connected' && c.canExec) { scanHost(c.serverId); scanTrHost(c.serverId) }
  api.on('conn:state', (st: ConnectionState) => {
    const prev = get().conns[st.serverId]
    set((s) => ({ conns: { ...s.conns, [st.serverId]: st } }))
    if (st.status === 'connected' && prev?.status !== 'connected') {
      refreshServers()
      if (st.canExec) { scanHost(st.serverId); scanTrHost(st.serverId) }
    }
    if (st.status !== 'connected' && prev?.status === 'connected') { forgetHost(st.serverId); forgetTrHost(st.serverId) }
    if (st.error === 'Connection lost' && prev?.status === 'connected') {
      toast({
        title: `Lost connection to ${serverName(st.serverId)}`,
        kind: 'error',
        action: { label: 'Reconnect', run: () => ensureConnected(st.serverId) },
      })
    }
  })
  api.on('settings', (s: Settings) => set({ settings: { ...DEFAULT_SETTINGS, ...s } }))
  api.update.state().then((u) => set({ update: u })).catch(() => {})
  api.on('update:state', (u: UpdateState) => {
    const prev = get().update
    set({ update: u })
    const openUpdates = () => openWindow('settings', { props: { pane: 'updates' } })
    if (u.status === 'available' && prev?.status !== 'available' && !get().settings.autoDownloadUpdates)
      toast({ title: `SSH OS ${u.version} is available`, body: `You have ${u.current}.`, action: { label: 'Update', run: () => { api.update.download(); openUpdates() } } })
    if (u.status === 'downloaded' && prev?.status !== 'downloaded')
      toast({ title: `SSH OS ${u.version} is ready to install`, body: 'Restart to finish updating. Connections will be closed.', kind: 'success', action: { label: 'Restart', run: () => api.update.install() } })
    if (u.status === 'error' && prev?.status === 'downloading') toast({ title: 'Update failed', body: u.error, kind: 'error' })
  })
  api.on('app:fullscreen', (f: boolean) => set({ fullscreen: f }))
  api.on('transfer', (t: Transfer) => {
    set((s) => {
      const idx = s.transfers.findIndex((x) => x.id === t.id)
      const next = [...s.transfers]
      if (idx >= 0) next[idx] = t
      else next.unshift(t)
      return { transfers: next.slice(0, 30) }
    })
    if (t.status === 'done' && t.kind !== 'download' && Date.now() - t.startedAt > 1500)
      toast({ title: t.kind === 'upload' ? 'Upload complete' : 'Copy complete', body: t.name, kind: 'success' })
    if (t.status === 'error' && t.error !== 'Cancelled') toast({ title: `Transfer failed: ${t.name}`, body: t.error, kind: 'error' })
  })
}

export async function updateSettings(p: Partial<Settings>) {
  set({ settings: { ...get().settings, ...p } })
  await api.settings.set(p)
}
