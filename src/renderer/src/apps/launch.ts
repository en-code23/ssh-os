import { APPS } from './meta'
import {
  AppId, ensureConnected, focusWindow, openWindow, pickServer, toast, useStore,
} from '../lib/store'

/**
 * Open an app. If it needs a server and none is given, uses the active connected
 * server; if none is connected, opens the Servers app instead.
 */
export async function launch(app: AppId, opts: { serverId?: string; props?: Record<string, any>; forceNew?: boolean; title?: string } = {}) {
  const meta = APPS[app]
  let serverId = opts.serverId
  if (meta.needsServer) {
    if (!serverId) serverId = pickServer(meta.needsExec)
    if (!serverId) {
      const st = useStore.getState()
      const anyConnected = Object.values(st.conns).some((c) => c.status === 'connected')
      if (anyConnected && meta.needsExec) toast({ title: `${meta.name} needs an SSH server`, body: 'FTP servers only support file browsing. Connect to an SSH server.' })
      openWindow('servers', { props: { hint: `Connect to a server to use ${meta.name}` } })
      return
    }
    if (!(await ensureConnected(serverId))) return
    const server = useStore.getState().servers.find((s) => s.id === serverId)
    if (meta.needsExec && server?.protocol !== 'ssh') {
      toast({ title: `${meta.name} needs SSH`, body: `${server?.name} is an FTP server — only Finder is available.`, kind: 'error' })
      return
    }
  }
  return openWindow(app, { serverId, props: opts.props, forceNew: opts.forceNew, title: opts.title })
}

/** Dock click: focus the most recent window of the app, else launch it */
export function activateApp(app: AppId) {
  const st = useStore.getState()
  const wins = st.windows.filter((w) => w.app === app).sort((a, b) => b.z - a.z)
  if (wins.length) {
    const minimized = wins.every((w) => w.minimized)
    if (minimized) focusWindow(wins[0].id)
    else if (st.focusedId && wins.some((w) => w.id === st.focusedId)) {
      // already in front: cycle
      const idx = wins.findIndex((w) => w.id === st.focusedId)
      focusWindow(wins[(idx + 1) % wins.length].id)
    } else focusWindow(wins.find((w) => !w.minimized)?.id ?? wins[0].id)
    return
  }
  launch(app)
}
