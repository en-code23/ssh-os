import { ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { LucideIcon } from 'lucide-react'
import { FileCategory } from '../lib/files'
import { kbd } from '../lib/api'

// ---------------- App icon (squircle) ----------------
export function AppIcon({ icon: Icon, bg, size = 48, glyph }: { icon: LucideIcon; bg: string; size?: number; glyph?: string }) {
  return (
    <div className="app-icon" style={{ width: size, height: size, background: bg }}>
      <Icon size={size * 0.54} strokeWidth={1.9} color={glyph ?? '#fff'} style={{ filter: 'drop-shadow(0 1px 1px rgba(0,0,0,.25))', zIndex: 1 }} />
    </div>
  )
}

// ---------------- File icons ----------------
const BADGE: Record<FileCategory, string> = {
  folder: '', link: '#8e8e93', image: '#34c759', video: '#ff2d55', audio: '#ff9500', archive: '#a2845e',
  code: '#007aff', script: '#30b0c7', config: '#8e8e93', text: '#8e8e93', web: '#ff9500', pdf: '#ff3b30', binary: '#636366',
}

export function FileIcon({ cat, size = 18, label, dimmed }: { cat: FileCategory; size?: number; label?: string; dimmed?: boolean }) {
  if (cat === 'folder') {
    return (
      <svg width={size} height={size} viewBox="0 0 64 64" style={{ flexShrink: 0, opacity: dimmed ? 0.55 : 1 }}>
        <defs>
          <linearGradient id="fback" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#5fb4f8" />
            <stop offset="1" stopColor="#3a96e8" />
          </linearGradient>
          <linearGradient id="ffront" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#8fd0ff" />
            <stop offset="1" stopColor="#55aef5" />
          </linearGradient>
        </defs>
        <path d="M6 14a4 4 0 0 1 4-4h14l5 5h25a4 4 0 0 1 4 4v31a4 4 0 0 1-4 4H10a4 4 0 0 1-4-4z" fill="url(#fback)" />
        <path d="M6 22a4 4 0 0 1 4-4h44a4 4 0 0 1 4 4v28a4 4 0 0 1-4 4H10a4 4 0 0 1-4-4z" fill="url(#ffront)" />
        <path d="M6 22a4 4 0 0 1 4-4h44a4 4 0 0 1 4 4v1H6z" fill="rgba(255,255,255,.25)" />
      </svg>
    )
  }
  const color = BADGE[cat]
  const showLabel = size >= 40 && label
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" style={{ flexShrink: 0 }}>
      <path d="M14 4h26l14 14v40a3 3 0 0 1-3 3H14a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3z" fill="#fdfdfd" stroke="rgba(0,0,0,.18)" strokeWidth="1" />
      <path d="M40 4v11a3 3 0 0 0 3 3h11" fill="#e8e8ea" stroke="rgba(0,0,0,.18)" strokeWidth="1" />
      {cat === 'image' ? (
        <g>
          <rect x="17" y="26" width="30" height="22" rx="2" fill="#7dd3fc" />
          <path d="M17 44l9-9 7 7 5-4 9 8v0a2 2 0 0 1-2 2H19a2 2 0 0 1-2-2z" fill="#34c759" />
          <circle cx="40" cy="32" r="3" fill="#fde047" />
        </g>
      ) : cat === 'link' ? (
        <path d="M24 44 L38 30 M30 30h8v8" stroke={color} strokeWidth="4" fill="none" strokeLinecap="round" />
      ) : showLabel ? (
        <>
          {[26, 31, 36].map((y) => <rect key={y} x="18" y={y} width="28" height="2" rx="1" fill="rgba(0,0,0,.12)" />)}
          <rect x="15" y="43" width="34" height="11" rx="3" fill={color} />
          <text x="32" y="51.5" textAnchor="middle" fontSize="8" fontWeight="700" fill="#fff" fontFamily="-apple-system, sans-serif">
            {label!.slice(0, 5).toUpperCase()}
          </text>
        </>
      ) : (
        <>
          {[24, 30, 36, 42].map((y) => <rect key={y} x="18" y={y} width={y === 42 ? 18 : 28} height="2.5" rx="1" fill="rgba(0,0,0,.14)" />)}
          <rect x="15" y="48" width="34" height="6" rx="2" fill={color} />
        </>
      )}
    </svg>
  )
}

// ---------------- Menus ----------------
export interface MenuItem {
  label?: string
  icon?: ReactNode
  shortcut?: string
  onClick?: () => void
  disabled?: boolean
  danger?: boolean
  separator?: boolean
  header?: string
  checked?: boolean
}

export function Menu({ x, y, items, onClose, minWidth }: { x: number; y: number; items: MenuItem[]; onClose: () => void; minWidth?: number }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x, y })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setPos({
      x: Math.max(4, Math.min(x, window.innerWidth - r.width - 6)),
      y: y + r.height > window.innerHeight - 6 ? Math.max(30, y - r.height) : y,
    })
  }, [x, y])
  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    setTimeout(() => {
      window.addEventListener('mousedown', close, true)
      window.addEventListener('contextmenu', close, true)
    })
    window.addEventListener('keydown', key)
    window.addEventListener('blur', onClose)
    return () => {
      window.removeEventListener('mousedown', close, true)
      window.removeEventListener('contextmenu', close, true)
      window.removeEventListener('keydown', key)
      window.removeEventListener('blur', onClose)
    }
  }, [onClose])
  return createPortal(
    <div ref={ref} className="menu" style={{ left: pos.x, top: pos.y, minWidth }} onContextMenu={(e) => e.preventDefault()}>
      {items.map((it, i) =>
        it.separator ? (
          <div key={i} className="menu-sep" />
        ) : it.header ? (
          <div key={i} className="menu-header">{it.header}</div>
        ) : (
          <div
            key={i}
            className={`menu-item ${it.disabled ? 'disabled' : ''} ${it.danger ? 'danger' : ''}`}
            onMouseUp={(e) => {
              if (it.disabled || e.button !== 0) return
              onClose()
              it.onClick?.()
            }}
          >
            <span className="mi-icon">{it.checked ? '✓' : it.icon}</span>
            <span className="mi-label">{it.label}</span>
            {it.shortcut && <span className="mi-shortcut">{kbd(it.shortcut)}</span>}
          </div>
        ),
      )}
    </div>,
    document.body,
  )
}

export function useMenu() {
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)
  const el = menu ? <Menu {...menu} onClose={() => setMenu(null)} /> : null
  return {
    el,
    open: (e: { clientX: number; clientY: number; preventDefault?: () => void; stopPropagation?: () => void }, items: MenuItem[]) => {
      e.preventDefault?.()
      e.stopPropagation?.()
      setMenu({ x: e.clientX, y: e.clientY, items })
    },
    openAt: (x: number, y: number, items: MenuItem[]) => setMenu({ x, y, items }),
  }
}

// ---------------- Small controls ----------------
export function Switch({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return <button className={`switch ${on ? 'on' : ''}`} onClick={() => onChange(!on)} role="switch" aria-checked={on} />
}

export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: ReactNode }[]; onChange: (v: T) => void }) {
  return (
    <div className="segmented">
      {options.map((o) => (
        <button key={o.value} className={o.value === value ? 'on' : ''} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Spinner({ size = 16 }: { size?: number }) {
  return <div className="spinner" style={{ width: size, height: size }} />
}
