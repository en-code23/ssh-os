import { useEffect, useState } from 'react'
import { HardDrive, Globe } from 'lucide-react'
import {
  closeWindow, ensureConnected, focusWindow, init, minimizeWindow, toggleMaximize, updateSettings, useStore,
} from '../lib/store'
import { Window, requestClose, sendWinAction } from './Window'
import { MenuBar } from './MenuBar'
import { Dock } from './Dock'
import { Overlays } from './Overlays'
import { launch } from '../apps/launch'
import { useMenu } from './ui'

document.documentElement.classList.add(window.api.platform === 'darwin' ? 'platform-mac' : 'platform-win')

function useTheme() {
  const appearance = useStore((s) => s.settings.appearance)
  const accent = useStore((s) => s.settings.accent)
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => {
      const dark = appearance === 'dark' || (appearance === 'auto' && mq.matches)
      document.documentElement.classList.toggle('dark', dark)
    }
    apply()
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [appearance])
  useEffect(() => {
    document.documentElement.style.setProperty('--accent', accent)
  }, [accent])
}

function handleAction(action: string) {
  const st = useStore.getState()
  const focused = st.windows.find((w) => w.id === st.focusedId)
  switch (action) {
    case 'about': return launch('about')
    case 'settings': return launch('settings')
    case 'updates': return launch('settings', { props: { pane: 'updates' } })
    case 'servers': return launch('servers')
    case 'new-finder': return launch('finder', { forceNew: true })
    case 'new-terminal': return launch('terminal', { forceNew: true })
    case 'spotlight': return useStore.setState({ spotlight: !st.spotlight })
    case 'toggle-hidden': return updateSettings({ showHiddenFiles: !st.settings.showHiddenFiles })
    case 'help': return launch('about', { props: { tab: 'shortcuts' } })
    case 'close-window': return focused && requestClose(focused.id)
    case 'minimize-window': return focused && minimizeWindow(focused.id)
    case 'zoom-window': return focused && toggleMaximize(focused.id)
    case 'cycle-windows': {
      const vis = st.windows.filter((w) => !w.minimized).sort((a, b) => a.z - b.z)
      if (vis.length > 1) focusWindow(vis[0].id)
      return
    }
    case 'new-tab':
      if (focused?.app === 'terminal' || focused?.app === 'editor' || focused?.app === 'finder') return sendWinAction(focused.id, 'new-tab')
      return launch('terminal', { forceNew: true })
    default:
      if (focused) sendWinAction(focused.id, action)
  }
}

export function Desktop() {
  const [ready, setReady] = useState(false)
  const windows = useStore((s) => s.windows)
  const wallpaper = useStore((s) => s.settings.wallpaper)
  const servers = useStore((s) => s.servers)
  const conns = useStore((s) => s.conns)
  const [selIcon, setSelIcon] = useState<string | null>(null)
  const menu = useMenu()
  useTheme()

  useEffect(() => {
    init().then(() => {
      setReady(true)
      const st = useStore.getState()
      if (st.servers.length === 0) launch('servers', { props: { addNew: true } })
    })
    const off = window.api.on('menu', handleAction)
    return off
  }, [])

  // remove windows whose server was deleted
  useEffect(() => {
    for (const w of windows) if (w.serverId && !servers.some((s) => s.id === w.serverId) && ready) closeWindow(w.id)
  }, [servers]) // eslint-disable-line

  const connected = servers.filter((s) => conns[s.id]?.status === 'connected')

  return (
    <div className="desktop" onContextMenu={(e) => e.preventDefault()}>
      <div
        className={`wallpaper wp-${wallpaper}`}
        onMouseDown={() => setSelIcon(null)}
        onContextMenu={(e) =>
          menu.open(e, [
            { label: 'New Finder Window', onClick: () => launch('finder', { forceNew: true }) },
            { label: 'New Terminal', onClick: () => launch('terminal', { forceNew: true }) },
            { separator: true },
            { label: 'Connect to Server…', onClick: () => launch('servers') },
            { label: 'Change Wallpaper…', onClick: () => launch('settings', { props: { pane: 'wallpaper' } }) },
          ])
        }
      />
      <div className="desktop-icons">
        {connected.map((s) => (
          <div
            key={s.id}
            className={`desktop-icon ${selIcon === s.id ? 'selected' : ''}`}
            onMouseDown={() => setSelIcon(s.id)}
            onDoubleClick={() => launch('finder', { serverId: s.id, forceNew: true })}
            onContextMenu={(e) =>
              menu.open(e, [
                { label: 'Open', onClick: () => launch('finder', { serverId: s.id, forceNew: true }) },
                { label: 'Open Terminal', disabled: s.protocol !== 'ssh', onClick: () => launch('terminal', { serverId: s.id, forceNew: true }) },
                { label: 'Activity Monitor', disabled: s.protocol !== 'ssh', onClick: () => launch('monitor', { serverId: s.id, forceNew: true }) },
                { separator: true },
                { label: `Eject “${s.name}”`, onClick: () => window.api.call('conn:disconnect', s.id) },
              ])
            }
          >
            <div className="icon-wrap" style={{ padding: 4 }}>
              <DriveIcon color={s.color} ftp={s.protocol !== 'ssh'} />
            </div>
            <div className="label">{s.name}</div>
          </div>
        ))}
      </div>

      {windows.map((w) => (
        <Window key={w.id} win={w} />
      ))}

      <MenuBar />
      <Dock />
      <Overlays />
      {menu.el}
      {!ready && null}
    </div>
  )
}

export function DriveIcon({ color, ftp, size = 56 }: { color: string; ftp?: boolean; size?: number }) {
  const Icon = ftp ? Globe : HardDrive
  return (
    <div
      style={{
        width: size, height: size * 0.78, borderRadius: size * 0.16,
        background: `linear-gradient(180deg, #f2f2f4, #c7c7cc)`,
        boxShadow: '0 2px 6px rgba(0,0,0,.4), inset 0 1px 0 #fff',
        display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative',
      }}
    >
      <Icon size={size * 0.42} color="#6e6e73" strokeWidth={1.6} />
      <div style={{ position: 'absolute', bottom: size * 0.09, right: size * 0.12, width: size * 0.1, height: size * 0.1, borderRadius: '50%', background: color, boxShadow: `0 0 6px ${color}` }} />
    </div>
  )
}

export { ensureConnected }
