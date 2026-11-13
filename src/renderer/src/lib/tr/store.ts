import { create } from 'zustand'
import { detectTrDirs, inspectTr, TrServer } from './server'

interface TrState {
  servers: Record<string, TrServer[]>
  scanning: Record<string, boolean>
}

export const useTr = create<TrState>(() => ({ servers: {}, scanning: {} }))

const key = (hostId: string) => 'tr:dirs:' + hostId
function extraDirs(hostId: string): string[] {
  try {
    return JSON.parse(localStorage.getItem(key(hostId)) || '[]')
  } catch {
    return []
  }
}
export function addTrDir(hostId: string, dir: string) {
  try { localStorage.setItem(key(hostId), JSON.stringify([...new Set([...extraDirs(hostId), dir])])) } catch { /* ignore */ }
}
export function removeTrDir(hostId: string, dir: string) {
  try { localStorage.setItem(key(hostId), JSON.stringify(extraDirs(hostId).filter((d) => d !== dir))) } catch { /* ignore */ }
}

export async function scanTrHost(hostId: string) {
  useTr.setState((s) => ({ scanning: { ...s.scanning, [hostId]: true } }))
  try {
    const dirs = [...new Set([...(await detectTrDirs(hostId)), ...extraDirs(hostId)])]
    const list = await inspectTr(hostId, dirs)
    useTr.setState((s) => ({ servers: { ...s.servers, [hostId]: list } }))
    return list
  } catch {
    useTr.setState((s) => ({ servers: { ...s.servers, [hostId]: s.servers[hostId] ?? [] } }))
    return []
  } finally {
    useTr.setState((s) => ({ scanning: { ...s.scanning, [hostId]: false } }))
  }
}

export async function refreshTrDirs(hostId: string, dirs: string[]) {
  const fresh = await inspectTr(hostId, dirs)
  useTr.setState((s) => {
    const cur = (s.servers[hostId] ?? []).filter((x) => !dirs.includes(x.dir))
    return { servers: { ...s.servers, [hostId]: [...cur, ...fresh].sort((a, b) => a.dir.localeCompare(b.dir)) } }
  })
}

export function forgetTrHost(hostId: string) {
  useTr.setState((s) => {
    const n = { ...s.servers }
    delete n[hostId]
    return { servers: n }
  })
}

export function anyTerraria(st = useTr.getState()) {
  return Object.values(st.servers).some((l) => l.length > 0)
}
