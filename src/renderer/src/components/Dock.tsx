import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { closeWindow, focusWindow, useStore } from '../lib/store'
import { APPS, DOCK_ORDER } from '../apps/meta'
import { activateApp, launch } from '../apps/launch'
import { AppIcon, useMenu } from './ui'
import type { AppId } from '../lib/store'
import { anyMinecraft, useMc } from '../lib/mc/store'
import { anyTerraria, useTr } from '../lib/tr/store'

/** Largest zoom factor of the icon under the cursor. */
const MAX_SCALE = 1.7
/** How many icons on each side are affected by the zoom. */
const SPREAD = 2.6
/** Spring time constants (ms): quick to grow, a little softer to settle. */
const TAU_IN = 55
const TAU_OUT = 110

/**
 * macOS-style Dock.
 * Magnification runs outside React: one requestAnimationFrame loop eases every icon's
 * scale toward its target and writes styles directly, so moving the mouse never
 * re-renders anything. Targets are computed from the icons' *resting* positions
 * (measured while nothing is zoomed), which removes the wobble you get when zoom is
 * derived from already-zoomed positions. Icons scale with a GPU transform from their
 * bottom edge, so they grow above a fixed-height bar instead of resizing it.
 */
export function Dock() {
  const windows = useStore((s) => s.windows)
  const size = useStore((s) => s.settings.dockSize)
  const magnify = useStore((s) => s.settings.dockMagnify)
  const servers = useStore((s) => s.servers)
  const showMc = useStore((s) => s.settings.showMinecraft)
  const mcFound = useMc((s) => anyMinecraft(s))
  const showTr = useStore((s) => s.settings.showTerraria)
  const trFound = useTr((s) => anyTerraria(s))
  const menu = useMenu()
  const [bouncing, setBouncing] = useState<Set<string>>(new Set())

  const running = new Set(windows.map((w) => w.app))
  const base: AppId[] = [...DOCK_ORDER]
  if (showMc === 'always' || (showMc !== 'never' && mcFound)) base.splice(base.indexOf('shortcuts'), 0, 'minecraft')
  if (showTr === 'always' || (showTr !== 'never' && trFound)) base.splice(base.indexOf('shortcuts'), 0, 'terraria')
  const extra = [...running].filter((a) => !base.includes(a)) as AppId[]
  const items = [...base, ...(extra.length ? ['sep' as const, ...extra] : [])]
  const layoutKey = items.join('|') + ':' + size

  // ---------------- animation state (refs only; no React state) ----------------
  const itemEls = useRef<Map<string, HTMLDivElement>>(new Map())
  const anim = useRef({
    mouseX: null as number | null,
    rest: new Map<string, number>(), // resting center X of each icon
    scale: new Map<string, number>(),
    raf: 0,
    last: 0,
    needsMeasure: true,
  })
  const reduceMotion = useRef(false)

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const set = () => (reduceMotion.current = mq.matches)
    set()
    mq.addEventListener('change', set)
    return () => mq.removeEventListener('change', set)
  }, [])

  const apply = useCallback(
    (id: string, s: number) => {
      const el = itemEls.current.get(id)
      if (!el) return
      // layout width grows so neighbours slide apart; the icon itself is a GPU transform
      el.style.width = `${(size * s).toFixed(2)}px`
      el.style.setProperty('--s', s.toFixed(4))
    },
    [size],
  )

  const measure = useCallback(() => {
    const a = anim.current
    a.rest.clear()
    for (const [id, el] of itemEls.current) {
      const r = el.getBoundingClientRect()
      a.rest.set(id, r.left + r.width / 2)
    }
    a.needsMeasure = false
  }, [])

  const target = useCallback(
    (id: string) => {
      const a = anim.current
      if (!magnify || a.mouseX === null) return 1
      const c = a.rest.get(id)
      if (c === undefined) return 1
      const d = Math.abs(a.mouseX - c)
      const range = size * SPREAD
      if (d >= range) return 1
      const k = Math.cos((d / range) * (Math.PI / 2))
      return 1 + (MAX_SCALE - 1) * k * k
    },
    [magnify, size],
  )

  const tick = useCallback(
    (now: number) => {
      const a = anim.current
      const dt = Math.min(64, a.last ? now - a.last : 16)
      a.last = now
      let moving = false
      for (const id of itemEls.current.keys()) {
        const cur = a.scale.get(id) ?? 1
        const t = target(id)
        let next: number
        if (reduceMotion.current) next = t
        else {
          const tau = t > cur ? TAU_IN : TAU_OUT
          next = cur + (t - cur) * (1 - Math.exp(-dt / tau))
          if (Math.abs(t - next) < 0.0015) next = t
        }
        if (next !== cur) {
          a.scale.set(id, next)
          apply(id, next)
        }
        if (next !== t) moving = true
      }
      if (moving || a.mouseX !== null) a.raf = requestAnimationFrame(tick)
      else {
        a.raf = 0
        a.last = 0
      }
    },
    [apply, target],
  )

  const kick = useCallback(() => {
    const a = anim.current
    if (!a.raf) {
      a.last = 0
      a.raf = requestAnimationFrame(tick)
    }
  }, [tick])

  // Re-measure resting positions whenever the set of icons or the size changes.
  useLayoutEffect(() => {
    const a = anim.current
    for (const id of [...a.scale.keys()]) if (!itemEls.current.has(id)) a.scale.delete(id)
    const settled = [...a.scale.values()].every((s) => s === 1)
    if (settled) measure()
    else a.needsMeasure = true
    for (const [id] of itemEls.current) apply(id, a.scale.get(id) ?? 1)
  }, [layoutKey, measure, apply])

  useEffect(() => {
    const onResize = () => {
      const a = anim.current
      if ([...a.scale.values()].every((s) => s === 1)) measure()
      else a.needsMeasure = true
    }
    // shrink back if the pointer leaves the window or the app loses focus mid-hover
    const reset = () => {
      if (anim.current.mouseX === null) return
      anim.current.mouseX = null
      kick()
    }
    const onDocOut = (e: MouseEvent) => {
      if (!e.relatedTarget) reset()
    }
    window.addEventListener('resize', onResize)
    window.addEventListener('blur', reset)
    document.addEventListener('mouseout', onDocOut)
    return () => {
      window.removeEventListener('resize', onResize)
      window.removeEventListener('blur', reset)
      document.removeEventListener('mouseout', onDocOut)
      cancelAnimationFrame(anim.current.raf)
    }
  }, [measure, kick])

  const onMove = (e: React.PointerEvent) => {
    const a = anim.current
    if (a.needsMeasure && [...a.scale.values()].every((s) => s === 1)) measure()
    a.mouseX = e.clientX
    kick()
  }
  const onLeave = () => {
    anim.current.mouseX = null
    kick()
  }

  // When magnification is switched off, settle everything back to normal size.
  useEffect(() => {
    if (!magnify) {
      anim.current.mouseX = null
      kick()
    }
  }, [magnify, kick])

  const bounce = (id: string) => {
    if (reduceMotion.current) return
    setBouncing((b) => new Set(b).add(id))
    setTimeout(() => setBouncing((b) => { const n = new Set(b); n.delete(id); return n }), 1300)
  }

  return (
    <div className="dock-wrap">
      <div
        className="dock"
        style={{ height: size + 14, ['--base' as string]: `${size}px`, ['--max' as string]: MAX_SCALE }}
        onPointerMove={onMove}
        onPointerLeave={onLeave}
      >
        {items.map((id, i) => {
          if (id === 'sep') return <div key={'sep' + i} className="dock-sep" />
          const app = APPS[id]
          const appWins = windows.filter((w) => w.app === id)
          return (
            <div
              key={id}
              ref={(el) => {
                if (el) itemEls.current.set(id, el)
                else itemEls.current.delete(id)
              }}
              className="dock-item"
              style={{ width: size * (anim.current.scale.get(id) ?? 1) }}
              onClick={() => {
                if (!running.has(id)) bounce(id)
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
              <div className={`dock-lift ${bouncing.has(id) ? 'bounce' : ''}`}>
                <div className="dock-icon">
                  <AppIcon icon={app.icon} bg={app.bg} size={Math.round(size * MAX_SCALE)} />
                </div>
              </div>
              <span className={`dot ${running.has(id) ? 'on' : ''}`} />
            </div>
          )
        })}
      </div>
      {menu.el}
    </div>
  )
}

