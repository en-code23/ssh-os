import type { FileEntry } from '../../../shared/types'
import { closeWindow, focusWindow, openWindow, toast, updateWindow, useStore } from './store'
import { category, isDirLike, isTextual } from './files'
import { api, uid } from './api'
import { launch } from '../apps/launch'

/** Notify every Finder showing `dir` on `serverId` to reload. */
export function fsChanged(serverId: string, dir: string) {
  window.dispatchEvent(new CustomEvent('fs-changed', { detail: { serverId, dir } }))
}

export function openInEditor(serverId: string, path: string) {
  const st = useStore.getState()
  const ed = st.windows.filter((w) => w.app === 'editor' && w.serverId === serverId).sort((a, b) => b.z - a.z)[0]
  if (ed) {
    updateWindow(ed.id, { props: { ...ed.props, openRequest: { path, nonce: uid() } } })
    focusWindow(ed.id)
  } else {
    launch('editor', { serverId, props: { openRequest: { path, nonce: uid() } }, forceNew: true })
  }
}

export function quickLook(serverId: string, entry: FileEntry, toggle = true) {
  const st = useStore.getState()
  const ql = st.windows.find((w) => w.app === 'quicklook')
  if (ql) {
    if (toggle && ql.props.entry?.path === entry.path) return closeWindow(ql.id)
    updateWindow(ql.id, { serverId, props: { entry }, title: entry.name })
    focusWindow(ql.id)
    return
  }
  openWindow('quicklook', { serverId, props: { entry }, title: entry.name })
}

export function getInfo(serverId: string, entry: FileEntry) {
  openWindow('info', { serverId, props: { entry }, title: `${entry.name} Info`, forceNew: true })
}

export async function openEntry(serverId: string, entry: FileEntry) {
  if (isDirLike(entry)) return
  const cat = category(entry)
  if (isTextual(entry)) return openInEditor(serverId, entry.path)
  if (['image', 'pdf', 'video', 'audio'].includes(cat)) return quickLook(serverId, entry, false)
  if (entry.size < 2 * 1024 * 1024 && cat !== 'archive') return openInEditor(serverId, entry.path)
  try {
    await api.fs.openLocally(serverId, entry.path)
  } catch (e: any) {
    toast({ title: `Couldn't open ${entry.name}`, body: e.message, kind: 'error' })
  }
}
