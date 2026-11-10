import { useEffect, useState } from 'react'
import { Pencil, Play, Plus, SquareTerminal, Trash2, X, Zap } from 'lucide-react'
import type { QuickCommand } from '../../../shared/types'
import { api, uid } from '../lib/api'
import { confirm, ensureConnected, pickServer, updateWindow, useStore, Win } from '../lib/store'
import { Toolbar } from '../components/Window'
import { Spinner, useMenu } from '../components/ui'
import { launch } from './launch'

const COLORS = ['#0a84ff', '#30d158', '#ff9f0a', '#ff453a', '#bf5af2', '#ff375f', '#64d2ff', '#5e5ce6']

export function Shortcuts({ win }: { win: Win }) {
  const allServers = useStore((s) => s.servers)
  const servers = allServers.filter((x) => x.protocol === 'ssh')
  const conns = useStore((s) => s.conns)
  const [serverId, setServerId] = useState<string | undefined>(() => pickServer(true) ?? servers[0]?.id)
  const [cmds, setCmds] = useState<QuickCommand[]>([])
  const [editing, setEditing] = useState<QuickCommand | null>(null)
  const [result, setResult] = useState<{ name: string; out: string; code: number | null; running: boolean } | null>(null)
  const menu = useMenu()

  useEffect(() => {
    api.commands.get().then(setCmds)
  }, [])

  useEffect(() => {
    const id = win.props.run
    if (!id || !cmds.length) return
    const c = cmds.find((x) => x.id === id)
    updateWindow(win.id, { props: { ...win.props, run: undefined } })
    if (c) run(c)
  }, [win.props.run, cmds]) // eslint-disable-line

  const persist = (n: QuickCommand[]) => {
    setCmds(n)
    api.commands.set(n)
  }

  const run = async (c: QuickCommand) => {
    const sid = c.serverId ?? serverId
    if (!sid) return launch('servers')
    if (!(await ensureConnected(sid))) return
    setResult({ name: c.name, out: '', code: null, running: true })
    try {
      const r = await api.exec(sid, c.command, 120000)
      setResult({ name: c.name, out: (r.stdout + (r.stderr ? '\n' + r.stderr : '')).trim(), code: r.code, running: false })
    } catch (e: any) {
      setResult({ name: c.name, out: e.message, code: 1, running: false })
    }
  }

  const visible = cmds.filter((c) => !c.serverId || c.serverId === serverId)

  return (
    <>
      <Toolbar>
        <div style={{ width: 84 }} />
        <div className="toolbar-title" style={{ flex: 1 }}>Shortcuts</div>
        <select className="select" style={{ width: 180 }} value={serverId ?? ''} onChange={(e) => setServerId(e.target.value)}>
          {servers.length === 0 && <option value="">No SSH servers</option>}
          {servers.map((s) => (
            <option key={s.id} value={s.id}>
              {conns[s.id]?.status === 'connected' ? '● ' : '○ '}{s.name}
            </option>
          ))}
        </select>
        <button className="tb-btn" title="New Shortcut" onClick={() => setEditing({ id: '', name: '', command: '', color: COLORS[0] })}>
          <Plus size={18} />
        </button>
      </Toolbar>
      <div className="grow scroll pad">
        <div className="tile-grid">
          {visible.map((c) => (
            <div
              key={c.id}
              className="tile"
              style={{ background: `linear-gradient(145deg, ${c.color ?? '#5e5ce6'}, color-mix(in srgb, ${c.color ?? '#5e5ce6'} 70%, black))` }}
              onClick={() => run(c)}
              onContextMenu={(e) =>
                menu.open(e, [
                  { label: 'Run', onClick: () => run(c) },
                  { label: 'Run in Terminal', onClick: () => serverId && launch('terminal', { serverId: c.serverId ?? serverId, forceNew: true, props: { command: c.command } }) },
                  { separator: true },
                  { label: 'Edit…', onClick: () => setEditing(c) },
                  { label: 'Duplicate', onClick: () => persist([...cmds, { ...c, id: uid(), name: c.name + ' copy' }]) },
                  { label: 'Delete', danger: true, onClick: async () => (await confirm(`Delete “${c.name}”?`, undefined, 'Delete', true)) && persist(cmds.filter((x) => x.id !== c.id)) },
                ])
              }
              title={c.command}
            >
              <Zap size={20} />
              <div>
                <div className="tile-name">{c.name}</div>
                <div className="small mono" style={{ opacity: 0.75, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.command}</div>
              </div>
              <div className="tile-actions">
                <button title="Run in Terminal" onClick={(e) => { e.stopPropagation(); serverId && launch('terminal', { serverId: c.serverId ?? serverId, forceNew: true, props: { command: c.command } }) }}>
                  <SquareTerminal size={12} />
                </button>
                <button title="Edit" onClick={(e) => { e.stopPropagation(); setEditing(c) }}>
                  <Pencil size={12} />
                </button>
              </div>
            </div>
          ))}
          <div className="tile" style={{ background: 'var(--hover)', color: 'var(--text-2)', alignItems: 'center', justifyContent: 'center', boxShadow: 'inset 0 0 0 1.5px var(--border)' }} onClick={() => setEditing({ id: '', name: '', command: '', color: COLORS[0] })}>
            <Plus size={26} />
            <div>New Shortcut</div>
          </div>
        </div>
      </div>
      {result && (
        <div style={{ borderTop: '1px solid var(--border)', height: '45%', display: 'flex', flexDirection: 'column', flexShrink: 0 }}>
          <div className="row" style={{ padding: '6px 12px', borderBottom: '1px solid var(--border)' }}>
            {result.running ? <Spinner size={12} /> : <span className={`status-dot ${result.code === 0 ? 'connected' : 'error'}`} />}
            <b className="grow">{result.name}</b>
            {!result.running && <span className="small muted">exit {result.code ?? '?'}</span>}
            <button className="tb-btn" onClick={() => api.copyText(result.out)} title="Copy output">Copy</button>
            <button className="tb-btn" onClick={() => setResult(null)}><X size={14} /></button>
          </div>
          <pre className="output" style={{ margin: 0, flex: 1, overflow: 'auto' }}>{result.out || (result.running ? '' : '(no output)')}</pre>
        </div>
      )}
      {editing && (
        <div className="modal-backdrop" style={{ position: 'absolute', paddingTop: 40 }} onMouseDown={(e) => e.target === e.currentTarget && setEditing(null)}>
          <div className="sheet" style={{ width: 460 }}>
            <h3>{editing.id ? 'Edit Shortcut' : 'New Shortcut'}</h3>
            <div className="form-row"><label>Name</label><input autoFocus className="input" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></div>
            <div className="form-row" style={{ alignItems: 'start' }}><label style={{ paddingTop: 6 }}>Command</label><textarea className="textarea" rows={4} value={editing.command} onChange={(e) => setEditing({ ...editing, command: e.target.value })} placeholder="e.g. sudo systemctl restart nginx" /></div>
            <div className="form-row">
              <label>Available on</label>
              <select className="select" value={editing.serverId ?? ''} onChange={(e) => setEditing({ ...editing, serverId: e.target.value || undefined })}>
                <option value="">All servers</option>
                {servers.map((s) => <option key={s.id} value={s.id}>{s.name} only</option>)}
              </select>
            </div>
            <div className="form-row">
              <label>Color</label>
              <div className="row">{COLORS.map((c) => <button key={c} className={`color-swatch ${editing.color === c ? 'on' : ''}`} style={{ background: c }} onClick={() => setEditing({ ...editing, color: c })} />)}</div>
            </div>
            <div className="sheet-actions">
              {editing.id && (
                <button className="btn" style={{ marginRight: 'auto' }} onClick={() => { persist(cmds.filter((x) => x.id !== editing.id)); setEditing(null) }}>
                  <Trash2 size={12} />
                </button>
              )}
              <button className="btn" onClick={() => setEditing(null)}>Cancel</button>
              <button
                className="btn primary"
                disabled={!editing.name.trim() || !editing.command.trim()}
                onClick={() => {
                  const c = { ...editing, id: editing.id || uid() }
                  persist(editing.id ? cmds.map((x) => (x.id === c.id ? c : x)) : [...cmds, c])
                  setEditing(null)
                }}
              >
                <Play size={11} /> Save
              </button>
            </div>
          </div>
        </div>
      )}
      {menu.el}
    </>
  )
}
