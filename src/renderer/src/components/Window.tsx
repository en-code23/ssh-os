import { createContext, memo, ReactNode, useContext, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Minus, Plus, X } from 'lucide-react'
import { closeWindow, focusWindow, minimizeWindow, toggleMaximize, updateWindow, useStore, Win } from '../lib/store'
import { APPS } from '../apps/meta'
import { COMPONENTS } from '../apps/registry'

const TitlebarCtx = createContext<HTMLElement | null>(null)

/** Renders children into the window's titlebar (Finder-style unified toolbar). */
export function Toolbar({ children }: { children: ReactNode }) {
  const el = useContext(TitlebarCtx)
  return el ? createPortal(children, el) : null
}

/** Subscribe to menu / keyboard actions targeted at this window. */
export function useWinAction(winId: string, fn: (action: string) => void) {
  const ref = useRef(fn)
  ref.current = fn
  useEffect(() => {
    const h = (e: Event) => {
      const d = (e as CustomEvent).detail
      if (d.winId === winId) ref.current(d.action)
    }
    window.addEventListener('win-action', h)
    return () => window.removeEventListener('win-action', h)
  }, [winId])
}

export function sendWinAction(winId: string, action: string) {
  window.dispatchEvent(new CustomEvent('win-action', { detail: { winId, action } }))
}

type Dir = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

export const Window = memo(function Window({ win }: { win: Win }) {
  const focused = useStore((s) => s.focusedId === win.id)
  const dockSize = useStore((s) => s.settings.dockSize)
  const serverName = useStore((s) => (win.serverId ? s.servers.find((x) => x.id === win.serverId)?.name : undefined))
  const meta = APPS[win.app]
  const Comp = COMPONENTS[win.app]
  const [titleEl, setTitleEl] = useState<HTMLElement | null>(null)
  const [geom, setGeom] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  const [animating, setAnimating] = useState(false)
  const prevMax = useRef(win.maximized)

  useEffect(() => {
    if (prevMax.current !== win.maximized) {
      prevMax.current = win.maximized
      setAnimating(true)
      const t = setTimeout(() => setAnimating(false), 260)
      return () => clearTimeout(t)
    }
  }, [win.maximized])

  const g = geom ?? win
  const style = win.maximized
    ? { left: 0, top: 28, width: '100%', height: `calc(100% - 28px - ${dockSize + 18}px)`, zIndex: win.z, borderRadius: 0 }
    : { left: g.x, top: g.y, width: g.w, height: g.h, zIndex: win.z }

  const startDrag = (e: React.MouseEvent) => {
    if (e.button !== 0) return
    const t = e.target as HTMLElement
    if (t.closest('button, input, select, textarea, .no-drag, [role=button]')) return
    e.preventDefault()
    const sx = e.clientX
    const sy = e.clientY
    let start = { x: win.x, y: win.y, w: win.w, h: win.h }
    if (win.maximized) {
      // un-maximize under the cursor
      const ratio = e.clientX / window.innerWidth
      start = { ...start, x: e.clientX - win.w * ratio, y: 28 }
      updateWindow(win.id, { maximized: false, x: start.x, y: start.y })
    }
    let cur = start
    const move = (ev: MouseEvent) => {
      cur = { ...start, x: start.x + ev.clientX - sx, y: Math.max(28, start.y + ev.clientY - sy) }
      setGeom(cur)
    }
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      updateWindow(win.id, { x: cur.x, y: cur.y })
      setGeom(null)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  const startResize = (dir: Dir) => (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const sx = e.clientX
    const sy = e.clientY
    const start = { x: win.x, y: win.y, w: win.w, h: win.h }
    let cur = start
    const MIN_W = 320
    const MIN_H = 200
    const move = (ev: MouseEvent) => {
      const dx = ev.clientX - sx
      const dy = ev.clientY - sy
      const n = { ...start }
      if (dir.includes('e')) n.w = Math.max(MIN_W, start.w + dx)
      if (dir.includes('s')) n.h = Math.max(MIN_H, start.h + dy)
      if (dir.includes('w')) {
        n.w = Math.max(MIN_W, start.w - dx)
        n.x = start.x + start.w - n.w
      }
      if (dir.includes('n')) {
        n.h = Math.max(MIN_H, start.h - dy)
        n.y = Math.max(28, start.y + start.h - n.h)
        n.h = start.y + start.h - n.y
      }
      cur = n
      setGeom(n)
    }
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      updateWindow(win.id, cur)
      setGeom(null)
      window.dispatchEvent(new Event('resize'))
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  const title = win.title || meta.name + (serverName && !meta.unified ? ` — ${serverName}` : '')

  return (
    <div
      className={`window ${focused ? 'focused' : ''} ${win.minimized ? 'minimized' : ''} ${meta.unified ? 'unified' : ''} ${animating ? 'animating' : ''}`}
      style={style}
      onMouseDownCapture={() => focusWindow(win.id)}
      data-win={win.id}
    >
      <div className="titlebar" onMouseDown={startDrag} onDoubleClick={(e) => {
        if ((e.target as HTMLElement).closest('button, input, .no-drag')) return
        toggleMaximize(win.id)
      }}>
        <div className="traffic">
          <button className="close" onClick={() => requestClose(win.id)} title="Close">
            {win.dirty ? <span className="dirty-dot" /> : null}
            <X strokeWidth={3} />
          </button>
          <button className="min" onClick={() => minimizeWindow(win.id)} title="Minimize">
            <Minus strokeWidth={3} />
          </button>
          <button className="max" onClick={() => toggleMaximize(win.id)} title="Zoom">
            <Plus strokeWidth={3} />
          </button>
        </div>
        {meta.unified ? (
          <div ref={setTitleEl} style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 0, marginLeft: 10 }} />
        ) : (
          <div className="title">{title}</div>
        )}
      </div>
      <div className="window-body">
        <TitlebarCtx.Provider value={titleEl}>
          <Comp win={win} />
        </TitlebarCtx.Provider>
      </div>
      {!win.maximized &&
        (['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as Dir[]).map((d) => (
          <div key={d} className={`resize ${d}`} onMouseDown={startResize(d)} />
        ))}
    </div>
  )
})

const closeGuards = new Map<string, () => Promise<boolean> | boolean>()

/** Register a guard that can veto closing (e.g. unsaved changes). */
export function useCloseGuard(winId: string, fn: () => Promise<boolean> | boolean) {
  const ref = useRef(fn)
  ref.current = fn
  useEffect(() => {
    closeGuards.set(winId, () => ref.current())
    return () => {
      closeGuards.delete(winId)
    }
  }, [winId])
}

export async function requestClose(winId: string) {
  const g = closeGuards.get(winId)
  if (g && !(await g())) return
  closeWindow(winId)
}
