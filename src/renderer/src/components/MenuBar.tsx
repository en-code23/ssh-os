import { useEffect, useRef, useState } from 'react'
import { ArrowDownUp, Box, Moon, Search, Server, Sun, X } from 'lucide-react'
import { disconnectServer, ensureConnected, focusWindow, updateSettings, useStore } from '../lib/store'
import { APPS } from '../apps/meta'
import { launch } from '../apps/launch'
import { Menu, MenuItem } from './ui'
import { formatBytes } from '../lib/files'
import { api, isMac } from '../lib/api'
import { createPortal } from 'react-dom'

function Clock() {
  const [now, setNow] = useState(new Date())
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 10000)
    return () => clearInterval(t)
  }, [])
  return (
    <span className="mb-item" style={{ fontVariantNumeric: 'tabular-nums' }}>
      {now.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })}&nbsp;&nbsp;
      {now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
    </span>
  )
}

function TransfersPopover({ x, onClose }: { x: number; onClose: () => void }) {
  const transfers = useStore((s) => s.transfers)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const h = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && onClose()
    setTimeout(() => window.addEventListener('mousedown', h))
    return () => window.removeEventListener('mousedown', h)
  }, [onClose])
  return createPortal(
    <div ref={ref} className="menu" style={{ top: 30, left: Math.min(x - 160, window.innerWidth - 340), width: 330, padding: 4 }}>
      <div className="row" style={{ justifyContent: 'space-between', padding: '4px 10px' }}>
        <b>Transfers</b>
        <button className="tb-btn" style={{ height: 20, fontSize: 11 }} onClick={() => useStore.setState({ transfers: useStore.getState().transfers.filter((t) => t.status === 'running') })}>
          Clear
        </button>
      </div>
      {transfers.length === 0 && <div className="muted" style={{ padding: 12, textAlign: 'center' }}>No transfers</div>}
      <div style={{ maxHeight: 360, overflow: 'auto' }}>
        {transfers.map((t) => {
          const pct = t.total ? Math.min(100, (t.done / t.total) * 100) : t.status === 'done' ? 100 : 0
          return (
            <div key={t.id} className="transfer-row">
              <ArrowDownUp size={16} className="muted" />
              <div className="grow">
                <div style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.name}</div>
                <div className="small muted">
                  {t.kind === 'upload' ? 'Upload' : t.kind === 'download' ? 'Download' : 'Copy'} ·{' '}
                  {t.status === 'running' ? `${formatBytes(t.kind === 'copy' ? t.done / 2 : t.done)} of ${formatBytes(t.kind === 'copy' ? t.total / 2 : t.total)}` : t.status === 'error' ? t.error : t.status === 'done' ? 'Completed' : 'Cancelled'}
                </div>
                {t.status === 'running' && <div className="progress"><div style={{ width: `${pct}%` }} /></div>}
              </div>
              {t.status === 'running' && (
                <button className="tb-btn" title="Cancel" onClick={() => api.cancelTransfer(t.id)}>
                  <X size={14} />
                </button>
              )}
            </div>
          )
        })}
      </div>
    </div>,
    document.body,
  )
}

export function MenuBar() {
  const focusedApp = useStore((s) => s.windows.find((w) => w.id === s.focusedId)?.app)
  const servers = useStore((s) => s.servers)
  const conns = useStore((s) => s.conns)
  const activeServerId = useStore((s) => s.activeServerId)
  const transfers = useStore((s) => s.transfers)
  const appearance = useStore((s) => s.settings.appearance)
  const fullscreen = useStore((s) => s.fullscreen)
  const [menu, setMenu] = useState<{ key: string; x: number; items: MenuItem[] } | null>(null)
  const [showTransfers, setShowTransfers] = useState<number | null>(null)
  const running = transfers.filter((t) => t.status === 'running').length

  const open = (key: string, e: React.MouseEvent, items: MenuItem[]) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setMenu(menu?.key === key ? null : { key, x: r.left, items })
  }

  const active = servers.find((s) => s.id === activeServerId && conns[s.id]?.status === 'connected')
  const connectedCount = servers.filter((s) => conns[s.id]?.status === 'connected').length

  const serverItems = (): MenuItem[] => [
    { header: 'Servers' },
    ...servers.map<MenuItem>((s) => {
      const st = conns[s.id]?.status
      return {
        label: s.name,
        icon: <span className={`status-dot ${st ?? 'disconnected'}`} />,
        shortcut: s.protocol.toUpperCase(),
        checked: s.id === activeServerId && st === 'connected',
        onClick: async () => {
          if (st !== 'connected') await ensureConnected(s.id)
          useStore.setState({ activeServerId: s.id })
        },
      }
    }),
    ...(servers.length === 0 ? [{ label: 'No servers yet', disabled: true }] : []),
    { separator: true },
    ...(active
      ? [
          { label: `Open “${active.name}” in Finder`, onClick: () => launch('finder', { serverId: active.id, forceNew: true }) },
          ...(active.protocol === 'ssh' ? [{ label: 'New Terminal', onClick: () => launch('terminal', { serverId: active.id, forceNew: true }) }] : []),
          { label: `Disconnect “${active.name}”`, onClick: () => disconnectServer(active.id) },
          { separator: true },
        ]
      : []),
    { label: 'Manage Servers…', shortcut: '⌘K', onClick: () => launch('servers') },
  ]

  return (
    <div className={`menubar ${fullscreen || !isMac ? '' : 'with-lights'}`} data-tauri-drag-region>
      <button
        className={`mb-item mb-logo ${menu?.key === 'logo' ? 'open' : ''}`}
        onMouseDown={(e) =>
          open('logo', e, [
            { label: 'About SSH OS', onClick: () => launch('about') },
            { label: useStore.getState().update?.status === 'downloaded' ? 'Restart to Update…' : 'Check for Updates…', onClick: () => { if (useStore.getState().update?.status === 'downloaded') api.update.install(); else { api.update.check(); launch('settings', { props: { pane: 'updates' } }) } } },
            { separator: true },
            { label: 'System Settings…', shortcut: '⌘,', onClick: () => launch('settings') },
            { label: 'Servers…', onClick: () => launch('servers') },
            { separator: true },
            { label: 'Disconnect All', disabled: connectedCount === 0, onClick: () => servers.forEach((s) => disconnectServer(s.id)) },
          ])
        }
      >
        <Box size={15} strokeWidth={2.2} />
      </button>
      <span className="mb-item bold">{focusedApp ? APPS[focusedApp].name : 'Finder'}</span>
      <button className={`mb-item ${menu?.key === 'server' ? 'open' : ''}`} onMouseDown={(e) => open('server', e, serverItems())}>
        {active ? (
          <>
            <span className="status-dot connected" />
            {active.name}
          </>
        ) : (
          <>
            <Server size={13} /> {servers.length ? 'Not connected' : 'Add a server'}
          </>
        )}
      </button>
      <button className={`mb-item`} onMouseDown={(e) => open('go', e, [
        { label: 'Finder', onClick: () => launch('finder') },
        { label: 'Terminal', onClick: () => launch('terminal') },
        { label: 'Code Editor', onClick: () => launch('editor') },
        { label: 'Activity Monitor', onClick: () => launch('monitor') },
        { label: 'Console', onClick: () => launch('console') },
        { label: 'Network Utility', onClick: () => launch('network') },
        { label: 'Shortcuts', onClick: () => launch('shortcuts') },
      ])}>
        Go
      </button>
      <button className={`mb-item`} onMouseDown={(e) => {
        const st = useStore.getState()
        open('window', e, [
          ...st.windows.map<MenuItem>((w) => ({
            label: w.title || APPS[w.app].name + (w.serverId ? ` — ${servers.find((s) => s.id === w.serverId)?.name ?? ''}` : ''),
            checked: w.id === st.focusedId,
            onClick: () => focusWindow(w.id),
          })),
          ...(st.windows.length === 0 ? [{ label: 'No Windows', disabled: true }] : []),
        ])
      }}>
        Window
      </button>
      <div className="spacer" data-tauri-drag-region />
      {(running > 0 || transfers.length > 0) && (
        <button className="mb-item" title="Transfers" onMouseDown={(e) => setShowTransfers(showTransfers === null ? e.clientX : null)}>
          <ArrowDownUp size={14} />
          {running > 0 && <span style={{ fontSize: 11 }}>{running}</span>}
        </button>
      )}
      <button className="mb-item" title="Connections" onMouseDown={(e) => open('conns', e, serverItems())}>
        <Server size={14} />
        {connectedCount > 0 && <span style={{ fontSize: 11 }}>{connectedCount}</span>}
      </button>
      <button
        className="mb-item"
        title="Toggle appearance"
        onClick={() => {
          const isDark = document.documentElement.classList.contains('dark')
          updateSettings({ appearance: isDark ? 'light' : 'dark' })
        }}
      >
        {appearance === 'dark' || (appearance === 'auto' && document.documentElement.classList.contains('dark')) ? <Sun size={14} /> : <Moon size={14} />}
      </button>
      <button className="mb-item" title={isMac ? 'Spotlight (⇧⌘Space)' : 'Spotlight (Ctrl+Shift+Space)'} onClick={() => useStore.setState({ spotlight: true })}>
        <Search size={14} />
      </button>
      <Clock />
      {!isMac && (
        <div className="win-controls">
          <button title="Minimize" onClick={() => window.api.win.minimize()}><svg viewBox="0 0 10 10"><path d="M1 5h8" /></svg></button>
          <button title="Maximize" onClick={() => window.api.win.toggleMaximize()}><svg viewBox="0 0 10 10"><rect x="1.5" y="1.5" width="7" height="7" /></svg></button>
          <button className="close" title="Close" onClick={() => window.api.win.close()}><svg viewBox="0 0 10 10"><path d="M1.5 1.5l7 7M8.5 1.5l-7 7" /></svg></button>
        </div>
      )}
      {menu && <Menu x={menu.x} y={28} items={menu.items} onClose={() => setMenu(null)} minWidth={240} />}
      {showTransfers !== null && <TransfersPopover x={showTransfers} onClose={() => setShowTransfers(null)} />}
    </div>
  )
}
