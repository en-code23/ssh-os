import { useRef, useState } from 'react'
import { closeWindow, focusWindow, useStore } from '../lib/store'
import { APPS, DOCK_ORDER } from '../apps/meta'
import { activateApp, launch } from '../apps/launch'
import { AppIcon, useMenu } from './ui'
import type { AppId } from '../lib/store'
import { anyMinecraft, useMc } from '../lib/mc/store'

export function Dock() {
  const windows = useStore((s) => s.windows)
  const size = useStore((s) => s.settings.dockSize)
  const magnify = useStore((s) => s.settings.dockMagnify)
  const servers = useStore((s) => s.servers)
  const [mouseX, setMouseX] = useState<number | null>(null)
  const refs = useRef<Record<string, HTMLDivElement | null>>({})
  const menu = useMenu()
  const [bouncing, setBouncing] = useState<string | null>(null)

  const showMc = useStore((s) => s.settings.showMinecraft)
  const mcFound = useMc((s) => anyMinecraft(s))
  const running = new Set(windows.map((w) => w.app))
  const base: AppId[] = [...DOCK_ORDER]
  if (showMc === 'always' || (showMc !== 'never' && mcFound)) base.splice(base.indexOf('shortcuts'), 0, 'minecraft')
  const extra = [...running].filter((a) => !base.includes(a)) as AppId[]
  const items = [...base, ...(extra.length ? ['sep' as const, ...extra] : [])]

  const scaleFor = (id: string) => {
    if (!magnify || mouseX === null) return 1
    const el = refs.current[id]
    if (!el) return 1
    const r = el.getBoundingClientRect()
    const center = r.left + r.width / 2
    const d = Math.abs(mouseX - center)
    const range = size * 2.6
    if (d > range) return 1
    return 1 + 0.55 * Math.cos((d / range) * (Math.PI / 2)) ** 2
  }

  return (
    <div className="dock-wrap">
      <div className="dock" onMouseMove={(e) => setMouseX(e.clientX)} onMouseLeave={() => setMouseX(null)}>
        {items.map((id, i) => {
          if (id === 'sep') return <div key={'sep' + i} className="dock-sep" />
          const app = APPS[id]
          const sc = scaleFor(id)
          const s = Math.round(size * sc)
          const appWins = windows.filter((w) => w.app === id)
          return (
            <div
              key={id}
              ref={(el) => { refs.current[id] = el }}
              className={`dock-item ${bouncing === id ? 'bounce' : ''}`}
              style={{ width: s, height: s }}
              onClick={() => {
                if (!running.has(id)) {
                  setBouncing(id)
                  setTimeout(() => setBouncing(null), 700)
                }
                activateApp(id)
              }}
              onContextMenu={(e) =>
                menu.open(e, [
                  ...appWins.map((w) => ({
                    label: w.title || app.name + (w.serverId ? ` — ${servers.find((x) => x.id === w.serverId)?.name ?? ''}` : ''),
                    onClick: () => focusWindow(w.id),
                  })),
                  ...(appWins.length ? [{ separator: true }] : []),
                  { label: 'New Window', onClick: () => launch(id, { forceNew: true }) },
                  ...(app.needsServer
                    ? [
                        { header: 'Open on…' },
                        ...servers
                          .filter((sv) => !app.needsExec || sv.protocol === 'ssh')
                          .map((sv) => ({ label: sv.name, onClick: () => launch(id, { serverId: sv.id, forceNew: true }) })),
                      ]
                    : []),
                  ...(appWins.length ? [{ separator: true }, { label: 'Quit', onClick: () => appWins.forEach((w) => closeWindow(w.id)) }] : []),
                ])
              }
            >
              <span className="tip">{app.name}</span>
              <AppIcon icon={app.icon} bg={app.bg} size={s} />
              {running.has(id) && <span className="dot" />}
            </div>
          )
        })}
      </div>
      {menu.el}
    </div>
  )
}
