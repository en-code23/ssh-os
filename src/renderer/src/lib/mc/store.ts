import { create } from 'zustand'
import { detectDirs, inspect, McServer } from './server'

interface McState {
  /** detected servers per SSH host */
  servers: Record<string, McServer[]>
  scanning: Record<string, boolean>
  /** extra folders added by hand, per host (persisted in localStorage) */
}

export const useMc = create<McState>(() => ({ servers: {}, scanning: {} }))

function extraDirs(hostId: string): string[] {
  try {
    return JSON.parse(localStorage.getItem('mc:dirs:' + hostId) || '[]')
  } catch {
    return []
  }
}

export function addExtraDir(hostId: string, dir: string) {
  const l = [...new Set([...extraDirs(hostId), dir])]
  try { localStorage.setItem('mc:dirs:' + hostId, JSON.stringify(l)) } catch { /* ignore */ }
}

export function removeExtraDir(hostId: string, dir: string) {
  const l = extraDirs(hostId).filter((d) => d !== dir)
  try { localStorage.setItem('mc:dirs:' + hostId, JSON.stringify(l)) } catch { /* ignore */ }
}

export async function scanHost(hostId: string) {
  useMc.setState((s) => ({ scanning: { ...s.scanning, [hostId]: true } }))
  try {
    const dirs = [...new Set([...(await detectDirs(hostId)), ...extraDirs(hostId)])]
    const list = await inspect(hostId, dirs)
    useMc.setState((s) => ({ servers: { ...s.servers, [hostId]: list } }))
    return list
  } catch {
    useMc.setState((s) => ({ servers: { ...s.servers, [hostId]: s.servers[hostId] ?? [] } }))
    return []
  } finally {
    useMc.setState((s) => ({ scanning: { ...s.scanning, [hostId]: false } }))
  }
}

/** Refresh just the given directories on a host (cheaper than a full scan). */
export async function refreshDirs(hostId: string, dirs: string[]) {
  const fresh = await inspect(hostId, dirs)
  useMc.setState((s) => {
    const cur = (s.servers[hostId] ?? []).filter((x) => !dirs.includes(x.dir))
    return { servers: { ...s.servers, [hostId]: [...cur, ...fresh].sort((a, b) => a.dir.localeCompare(b.dir)) } }
  })
  return fresh
}

export function forgetHost(hostId: string) {
  useMc.setState((s) => {
    const n = { ...s.servers }
    delete n[hostId]
    return { servers: n }
  })
}

export function anyMinecraft(st = useMc.getState()) {
  return Object.values(st.servers).some((l) => l.length > 0)
}
