import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, CheckCircle2, Info, KeyRound, Search, Server, Zap } from 'lucide-react'
import { dismissToast, ensureConnected, useStore } from '../lib/store'
import { APPS } from '../apps/meta'
import { launch } from '../apps/launch'
import { AppIcon, Switch } from './ui'
import { api } from '../lib/api'
import type { QuickCommand } from '../../../shared/types'
import type { AppId } from '../lib/store'

function Toasts() {
  const toasts = useStore((s) => s.toasts)
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className="toast" onClick={() => dismissToast(t.id)}>
          {t.kind === 'error' ? (
            <AlertTriangle size={22} color="var(--red)" />
          ) : t.kind === 'success' ? (
            <CheckCircle2 size={22} color="var(--green)" />
          ) : (
            <Info size={22} color="var(--accent)" />
          )}
          <div className="grow">
            <div className="t-title">{t.title}</div>
            {t.body && <div className="t-body">{t.body}</div>}
          </div>
          {t.action && (
            <button
              className="btn"
              onClick={(e) => {
                e.stopPropagation()
                dismissToast(t.id)
                t.action!.run()
              }}
            >
              {t.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  )
}

function Dialogs() {
  const d = useStore((s) => s.dialogs[0])
  const [value, setValue] = useState('')
  const [remember, setRemember] = useState(true)
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (!d) return
    setValue(d.defaultValue ?? '')
    setTimeout(() => {
      const el = inputRef.current
      if (!el) return
      el.focus()
      // select filename without extension like Finder
      const dot = (d.defaultValue ?? '').lastIndexOf('.')
      if (dot > 0) el.setSelectionRange(0, dot)
      else el.select()
    }, 30)
  }, [d?.id]) // eslint-disable-line
  if (!d) return null
  const ok = () => {
    if (d.kind === 'confirm') d.resolve(true)
    else if (d.kind === 'password') d.resolve({ password: value, remember })
    else d.resolve(value)
  }
  const cancel = () => d.resolve(d.kind === 'confirm' ? false : null)
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && cancel()}>
      <div
        className={`alert ${d.kind !== 'confirm' ? 'wide' : ''}`}
        onKeyDown={(e) => {
          if (e.key === 'Escape') cancel()
          if (e.key === 'Enter') ok()
          e.stopPropagation()
        }}
        tabIndex={-1}
        ref={(el) => { if (d.kind === 'confirm') el?.focus() }}
      >
        <div style={{ display: 'flex', justifyContent: d.kind === 'confirm' ? 'center' : 'flex-start', gap: 12, alignItems: 'center' }}>
          {d.kind === 'password' ? (
            <AppIcon icon={KeyRound} bg="linear-gradient(180deg,#a1a1a6,#636366)" size={44} />
          ) : d.kind === 'confirm' ? (
            <AppIcon icon={d.destructive ? AlertTriangle : Info} bg={d.destructive ? 'linear-gradient(180deg,#ffb340,#ff9500)' : 'linear-gradient(180deg,#5ac8fa,#007aff)'} size={52} />
          ) : null}
          {d.kind !== 'confirm' && (
            <div>
              <h4 style={{ margin: 0 }}>{d.title}</h4>
              {d.message && <p style={{ margin: '2px 0 0' }}>{d.message}</p>}
            </div>
          )}
        </div>
        {d.kind === 'confirm' && (
          <>
            <h4>{d.title}</h4>
            {d.message && <p>{d.message}</p>}
          </>
        )}
        {d.kind !== 'confirm' && (
          <input
            ref={inputRef}
            className="input"
            style={{ marginTop: 14 }}
            type={d.kind === 'password' ? 'password' : 'text'}
            placeholder={d.kind === 'password' ? 'Password' : ''}
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
        )}
        {d.kind === 'password' && (
          <label className="row" style={{ marginTop: 10, fontSize: 12 }}>
            <Switch on={remember} onChange={setRemember} /> Remember in Keychain
          </label>
        )}
        <div className="actions">
          <button className="btn" onClick={cancel}>Cancel</button>
          <button className={`btn ${d.destructive ? 'danger' : 'primary'}`} onClick={ok}>{d.okLabel ?? 'OK'}</button>
        </div>
      </div>
    </div>
  )
}

interface SpotItem {
  group: string
  key: string
  label: string
  sub?: string
  icon: React.ReactNode
  run: () => void
}

function Spotlight() {
  const open = useStore((s) => s.spotlight)
  const servers = useStore((s) => s.servers)
  const conns = useStore((s) => s.conns)
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(0)
  const [cmds, setCmds] = useState<QuickCommand[]>([])
  useEffect(() => {
    if (open) {
      setQ('')
      setSel(0)
      api.commands.get().then(setCmds)
    }
  }, [open])
  const close = () => useStore.setState({ spotlight: false })

  const items = useMemo<SpotItem[]>(() => {
    const ql = q.toLowerCase().trim()
    const m = (s: string) => !ql || s.toLowerCase().includes(ql)
    const out: SpotItem[] = []
    for (const a of Object.values(APPS)) {
      if (['quicklook', 'info'].includes(a.id)) continue
      if (a.id === 'minecraft' && useStore.getState().settings.showMinecraft === 'never') continue
      if (a.id === 'terraria' && useStore.getState().settings.showTerraria === 'never') continue
      if (m(a.name)) out.push({ group: 'Applications', key: a.id, label: a.name, icon: <AppIcon icon={a.icon} bg={a.bg} size={24} />, run: () => launch(a.id as AppId, { forceNew: true }) })
    }
    for (const s of servers) {
      if (m(s.name) || m(s.host) || (s.protocol === 'ssh' && m('terminal ' + s.name))) {
        const connected = conns[s.id]?.status === 'connected'
        out.push({
          group: 'Servers',
          key: 's' + s.id,
          label: connected ? `Open ${s.name}` : `Connect to ${s.name}`,
          sub: `${s.username}@${s.host}`,
          icon: <span className="server-avatar" style={{ width: 24, height: 24, borderRadius: 6, background: s.color }}><Server size={13} /></span>,
          run: async () => {
            if (await ensureConnected(s.id)) launch('finder', { serverId: s.id, forceNew: true })
          },
        })
        if (s.protocol === 'ssh')
          out.push({
            group: 'Servers', key: 't' + s.id, label: `Terminal on ${s.name}`, sub: s.host,
            icon: <AppIcon icon={APPS.terminal.icon} bg={APPS.terminal.bg} size={24} />,
            run: () => launch('terminal', { serverId: s.id, forceNew: true }),
          })
      }
    }
    for (const c of cmds) {
      if (m(c.name) || m(c.command))
        out.push({
          group: 'Shortcuts', key: 'c' + c.id, label: c.name, sub: c.command,
          icon: <span className="server-avatar" style={{ width: 24, height: 24, borderRadius: 6, background: c.color ?? '#5e5ce6' }}><Zap size={13} /></span>,
          run: () => launch('shortcuts', { props: { run: c.id } }),
        })
    }
    return out.slice(0, 40)
  }, [q, servers, conns, cmds])

  if (!open) return null
  const pick = (i: number) => {
    const it = items[i]
    if (!it) return
    close()
    it.run()
  }
  let lastGroup = ''
  return (
    <div className="spotlight-wrap" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="spotlight">
        <div className="sp-input">
          <Search size={22} className="muted" />
          <input
            autoFocus
            placeholder="Spotlight Search"
            value={q}
            onChange={(e) => {
              setQ(e.target.value)
              setSel(0)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') close()
              else if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(items.length - 1, s + 1)) }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(0, s - 1)) }
              else if (e.key === 'Enter') pick(sel)
            }}
          />
        </div>
        {items.length > 0 && (
          <div className="sp-results">
            {items.map((it, i) => {
              const header = it.group !== lastGroup ? it.group : null
              lastGroup = it.group
              return (
                <div key={it.key}>
                  {header && <div className="sp-group">{header}</div>}
                  <div className={`sp-row ${i === sel ? 'sel' : ''}`} onMouseMove={() => setSel(i)} onClick={() => pick(i)}>
                    {it.icon}
                    <div className="grow">
                      <div>{it.label}</div>
                      {it.sub && <div className="small muted mono" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.sub}</div>}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

export function Overlays() {
  return (
    <>
      <Toasts />
      <Dialogs />
      <Spotlight />
    </>
  )
}
