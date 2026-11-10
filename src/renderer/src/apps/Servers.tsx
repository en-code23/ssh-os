import { useEffect, useMemo, useState } from 'react'
import { Download, FolderOpen, Globe, HardDrive, Plus, Search, Server, Terminal as TermIcon, Activity, Trash2, Pickaxe } from 'lucide-react'
import type { ServerConfig } from '../../../shared/types'
import { api } from '../lib/api'
import { confirm, disconnectServer, ensureConnected, refreshServers, toast, updateWindow, useStore, Win } from '../lib/store'
import { Toolbar } from '../components/Window'
import { Segmented, Spinner, useMenu } from '../components/ui'
import { launch } from './launch'

const COLORS = ['#0a84ff', '#30d158', '#ff9f0a', '#ff453a', '#bf5af2', '#ff375f', '#64d2ff', '#ffd60a', '#8e8e93']

const blank = (): Partial<ServerConfig> => ({
  name: '',
  protocol: 'ssh',
  host: '',
  port: 22,
  username: '',
  authMethod: 'password',
  color: COLORS[Math.floor(Math.random() * COLORS.length)],
})

export function Servers({ win }: { win: Win }) {
  const servers = useStore((s) => s.servers)
  const conns = useStore((s) => s.conns)
  const [selId, setSelId] = useState<string | 'new' | null>(win.props.addNew ? 'new' : servers[0]?.id ?? 'new')
  const [q, setQ] = useState('')
  const menu = useMenu()

  useEffect(() => {
    if (win.props.addNew) {
      setSelId('new')
      updateWindow(win.id, { props: { ...win.props, addNew: false } })
    }
  }, [win.props.addNew]) // eslint-disable-line

  useEffect(() => {
    if (selId && selId !== 'new' && !servers.some((s) => s.id === selId)) setSelId(servers[0]?.id ?? 'new')
  }, [servers, selId])

  const filtered = useMemo(
    () => servers.filter((s) => !q || `${s.name} ${s.host} ${s.username} ${s.group ?? ''}`.toLowerCase().includes(q.toLowerCase())),
    [servers, q],
  )
  const groups = useMemo(() => {
    const m = new Map<string, ServerConfig[]>()
    for (const s of filtered) {
      const g = s.group || 'Servers'
      m.set(g, [...(m.get(g) ?? []), s])
    }
    return [...m.entries()]
  }, [filtered])

  const importSsh = async () => {
    const found = await api.servers.importSshConfig()
    const existing = new Set(servers.map((s) => `${s.host}:${s.port}:${s.username}`))
    const fresh = found.filter((f) => f.host && !existing.has(`${f.host}:${f.port}:${f.username}`))
    if (!fresh.length) return toast({ title: 'Nothing to import', body: found.length ? 'All hosts from ~/.ssh/config are already added.' : 'No hosts found in ~/.ssh/config.' })
    for (const f of fresh) await api.servers.save({ ...blank(), ...f, group: 'SSH Config', username: f.username || '', createdAt: Date.now() })
    await refreshServers()
    toast({ title: `Imported ${fresh.length} server${fresh.length > 1 ? 's' : ''}`, body: 'From ~/.ssh/config', kind: 'success' })
  }

  const connectAndOpen = async (s: ServerConfig) => {
    if (await ensureConnected(s.id)) launch('finder', { serverId: s.id, forceNew: true })
  }

  const rowMenu = (e: React.MouseEvent, s: ServerConfig) => {
    const st = conns[s.id]?.status
    menu.open(e, [
      st === 'connected' ? { label: 'Disconnect', onClick: () => disconnectServer(s.id) } : { label: 'Connect', onClick: () => ensureConnected(s.id) },
      { label: 'Open in Finder', onClick: () => connectAndOpen(s) },
      ...(s.protocol === 'ssh'
        ? [
            { label: 'Open Terminal', onClick: () => launch('terminal', { serverId: s.id, forceNew: true }) },
            { label: 'Activity Monitor', onClick: () => launch('monitor', { serverId: s.id, forceNew: true }) },
          ]
        : []),
      { separator: true },
      {
        label: 'Duplicate',
        onClick: async () => {
          const { id, ...rest } = s
          const n = await api.servers.save({ ...rest, name: s.name + ' copy', createdAt: Date.now() })
          await refreshServers()
          setSelId(n.id)
        },
      },
      { label: 'Delete…', danger: true, onClick: () => del(s) },
    ])
  }

  const del = async (s: ServerConfig) => {
    if (!(await confirm(`Delete “${s.name}”?`, 'The server and its saved password will be removed.', 'Delete', true))) return
    await api.servers.remove(s.id)
    await refreshServers()
  }

  const sel = selId === 'new' ? null : servers.find((s) => s.id === selId)

  return (
    <>
      <Toolbar>
        <div style={{ width: 90 }} />
        <div className="toolbar-title" style={{ flex: 1 }}>Servers</div>
        <button className="tb-btn" title="Import from ~/.ssh/config" onClick={importSsh}>
          <Download size={16} /> <span style={{ fontSize: 12 }}>Import</span>
        </button>
        <button className="tb-btn" title="Add Server" onClick={() => setSelId('new')}>
          <Plus size={18} />
        </button>
        <div className="search">
          <Search size={13} />
          <input placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </Toolbar>
      <div className="split">
        <div className="sidebar" style={{ width: 260, padding: 8 }}>
          {win.props.hint && (
            <div className="card small" style={{ marginBottom: 8, background: 'color-mix(in srgb, var(--accent) 12%, transparent)' }}>
              {win.props.hint}
            </div>
          )}
          {groups.map(([g, list]) => (
            <div key={g}>
              <div className="sb-section">{g}</div>
              {list.map((s) => {
                const st = conns[s.id]?.status ?? 'disconnected'
                return (
                  <div
                    key={s.id}
                    className={`server-row ${selId === s.id ? 'sel' : ''}`}
                    onMouseDown={() => setSelId(s.id)}
                    onDoubleClick={() => connectAndOpen(s)}
                    onContextMenu={(e) => rowMenu(e, s)}
                  >
                    <div className="server-avatar" style={{ background: s.color }}>
                      {s.protocol === 'ssh' ? <HardDrive size={17} /> : <Globe size={17} />}
                    </div>
                    <div className="grow">
                      <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</div>
                      <div className="small muted" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {s.username ? `${s.username}@` : ''}{s.host}
                      </div>
                    </div>
                    <span className={`status-dot ${st}`} title={st} />
                  </div>
                )
              })}
            </div>
          ))}
          {servers.length === 0 && (
            <div className="empty small" style={{ padding: 20 }}>
              No servers yet.
              <br />
              Add one or import from ~/.ssh/config.
            </div>
          )}
        </div>
        <div className="grow scroll" style={{ background: 'var(--win-bg)' }}>
          <ServerForm key={selId ?? 'none'} server={sel ?? null} onSaved={(id) => setSelId(id)} onDelete={sel ? () => del(sel) : undefined} />
        </div>
      </div>
      {menu.el}
    </>
  )
}

function ServerForm({ server, onSaved, onDelete }: { server: ServerConfig | null; onSaved: (id: string) => void; onDelete?: () => void }) {
  const [f, setF] = useState<Partial<ServerConfig> & { clearPassword?: boolean }>(() => (server ? { ...server } : blank()))
  const [busy, setBusy] = useState<'' | 'test' | 'save' | 'connect'>('')
  const conn = useStore((s) => (server ? s.conns[server.id] : undefined))
  const set = (p: Partial<ServerConfig> & { clearPassword?: boolean }) => setF((x) => ({ ...x, ...p }))
  const isNew = !server

  const valid = !!f.host?.trim() && (f.protocol !== 'ssh' || !!f.username?.trim())

  const save = async () => {
    const payload = { ...f, name: f.name?.trim() || f.host, createdAt: f.createdAt || Date.now() }
    const s = await api.servers.save(payload)
    await refreshServers()
    onSaved(s.id)
    return s
  }

  const wrap = (k: typeof busy, fn: () => Promise<void>) => async () => {
    setBusy(k)
    try {
      await fn()
    } catch (e: any) {
      toast({ title: k === 'test' ? 'Connection test failed' : 'Error', body: e.message === 'NEED_PASSWORD' ? 'A password is required.' : e.message, kind: 'error' })
    } finally {
      setBusy('')
    }
  }

  const st = conn?.status

  return (
    <div className="pad" style={{ maxWidth: 560, margin: '0 auto', paddingTop: 24 }}>
      <div className="row" style={{ gap: 14, marginBottom: 20 }}>
        <div className="server-avatar" style={{ background: f.color, width: 54, height: 54, borderRadius: 13 }}>
          {f.protocol === 'ssh' ? <HardDrive size={26} /> : <Globe size={26} />}
        </div>
        <div className="grow">
          <div style={{ fontSize: 18, fontWeight: 700 }}>{isNew ? 'New Server' : server!.name}</div>
          <div className="muted small">
            {isNew ? 'Connect over SSH (with SFTP file access), FTP or FTPS' : (
              <span className="row" style={{ gap: 6 }}>
                <span className={`status-dot ${st ?? 'disconnected'}`} />
                {st === 'connected' ? 'Connected' : st === 'connecting' ? 'Connecting…' : conn?.error && conn.error !== 'NEED_PASSWORD' ? conn.error : 'Not connected'}
              </span>
            )}
          </div>
        </div>
        {!isNew && (
          st === 'connected' ? (
            <button className="btn" onClick={() => disconnectServer(server!.id)}>Disconnect</button>
          ) : (
            <button className="btn primary" disabled={st === 'connecting'} onClick={() => ensureConnected(server!.id)}>
              {st === 'connecting' ? <Spinner size={12} /> : null} Connect
            </button>
          )
        )}
      </div>

      {!isNew && st === 'connected' && (
        <div className="row" style={{ marginBottom: 18, gap: 8, flexWrap: 'wrap' }}>
          <button className="btn" onClick={() => launch('finder', { serverId: server!.id, forceNew: true })}><FolderOpen size={13} /> Finder</button>
          {server!.protocol === 'ssh' && (
            <>
              <button className="btn" onClick={() => launch('terminal', { serverId: server!.id, forceNew: true })}><TermIcon size={13} /> Terminal</button>
              <button className="btn" onClick={() => launch('monitor', { serverId: server!.id, forceNew: true })}><Activity size={13} /> Activity</button>
              <button className="btn" onClick={() => launch('minecraft', { props: { create: true, hostId: server!.id } })}><Pickaxe size={13} /> New Minecraft Server</button>
            </>
          )}
        </div>
      )}

      <div className="form-row">
        <label>Protocol</label>
        <div>
          <Segmented
            value={f.protocol!}
            options={[
              { value: 'ssh', label: 'SSH / SFTP' },
              { value: 'ftp', label: 'FTP' },
              { value: 'ftps', label: 'FTPS' },
            ]}
            onChange={(v) => set({ protocol: v, port: v === 'ssh' ? 22 : 21, authMethod: v === 'ssh' ? f.authMethod : 'password' })}
          />
        </div>
      </div>
      <div className="form-row">
        <label>Name</label>
        <input className="input" placeholder={f.host || 'My Raspberry Pi'} value={f.name ?? ''} onChange={(e) => set({ name: e.target.value })} />
      </div>
      <div className="form-row">
        <label>Address</label>
        <div className="row">
          <input className="input" placeholder="192.168.1.10 or example.com" value={f.host ?? ''} onChange={(e) => set({ host: e.target.value.trim() })} />
          <span className="muted">:</span>
          <input className="input" style={{ width: 70 }} value={f.port ?? ''} onChange={(e) => set({ port: parseInt(e.target.value) || 0 })} />
        </div>
      </div>
      <div className="form-row">
        <label>Username</label>
        <input className="input" placeholder={f.protocol === 'ssh' ? 'pi' : 'anonymous'} value={f.username ?? ''} onChange={(e) => set({ username: e.target.value.trim() })} />
      </div>
      {f.protocol === 'ssh' && (
        <div className="form-row">
          <label>Authentication</label>
          <div>
            <Segmented
              value={f.authMethod!}
              options={[
                { value: 'password', label: 'Password' },
                { value: 'key', label: 'Key File' },
                { value: 'agent', label: 'SSH Agent' },
              ]}
              onChange={(v) => set({ authMethod: v })}
            />
          </div>
        </div>
      )}
      {(f.authMethod === 'password' || f.protocol !== 'ssh') && (
        <div className="form-row">
          <label>Password</label>
          <div className="row">
            <input
              className="input"
              type="password"
              placeholder={server?.hasPassword && !f.clearPassword ? '•••••••• (saved in Keychain)' : 'Ask when connecting'}
              value={f.password ?? ''}
              onChange={(e) => set({ password: e.target.value, clearPassword: false })}
            />
            {server?.hasPassword && !f.clearPassword && (
              <button className="btn" onClick={() => set({ clearPassword: true, password: '' })}>Forget</button>
            )}
          </div>
        </div>
      )}
      {f.protocol === 'ssh' && f.authMethod === 'key' && (
        <>
          <div className="form-row">
            <label>Private Key</label>
            <div className="row">
              <input className="input mono" placeholder="~/.ssh/id_ed25519" value={f.privateKeyPath ?? ''} onChange={(e) => set({ privateKeyPath: e.target.value })} />
              <button className="btn" onClick={async () => { const p = await api.pickKey(); if (p) set({ privateKeyPath: p }) }}>Choose…</button>
            </div>
          </div>
          <div className="form-row">
            <label>Passphrase</label>
            <input className="input" type="password" placeholder={server?.hasPassphrase ? '•••••••• (saved)' : 'Optional'} value={f.passphrase ?? ''} onChange={(e) => set({ passphrase: e.target.value })} />
          </div>
        </>
      )}
      {f.protocol === 'ftps' && (
        <div className="form-row">
          <label />
          <label className="row" style={{ textAlign: 'left', color: 'var(--text)' }}>
            <input type="checkbox" checked={!!f.allowUntrusted} onChange={(e) => set({ allowUntrusted: e.target.checked })} />
            Allow self-signed certificates (less secure)
          </label>
        </div>
      )}
      <div className="form-row">
        <label>Start Folder</label>
        <input className="input mono" placeholder="Home folder" value={f.defaultPath ?? ''} onChange={(e) => set({ defaultPath: e.target.value })} />
      </div>
      <div className="form-row">
        <label>Group</label>
        <input className="input" placeholder="Servers" value={f.group ?? ''} onChange={(e) => set({ group: e.target.value })} />
      </div>
      <div className="form-row">
        <label>Color</label>
        <div className="row">
          {COLORS.map((c) => (
            <button key={c} className={`color-swatch ${f.color === c ? 'on' : ''}`} style={{ background: c }} onClick={() => set({ color: c })} />
          ))}
        </div>
      </div>

      {conn?.fingerprint && (
        <div className="form-row">
          <label>Host Key</label>
          <div className="row small mono muted" style={{ wordBreak: 'break-all' }}>
            {conn.fingerprint}
          </div>
        </div>
      )}

      <div className="sheet-actions" style={{ justifyContent: 'space-between' }}>
        <div className="row">
          {onDelete && (
            <button className="btn" onClick={onDelete} title="Delete server">
              <Trash2 size={13} />
            </button>
          )}
          {!isNew && f.protocol === 'ssh' && (
            <button
              className="btn"
              title="Use this if the server was reinstalled and its host key changed"
              onClick={async () => {
                if (await confirm('Forget the saved host key?', 'Only do this if you know the server was reinstalled or its key changed.', 'Forget'))
                  await api.servers.forgetHostKey(f.host!, f.port!).then(() => toast({ title: 'Host key forgotten', kind: 'success' }))
              }}
            >
              Forget Host Key
            </button>
          )}
        </div>
        <div className="row">
          <button
            className="btn"
            disabled={!valid || !!busy}
            onClick={wrap('test', async () => {
              await api.servers.test(f)
              toast({ title: 'Connection succeeded', body: `${f.username}@${f.host}`, kind: 'success' })
            })}
          >
            {busy === 'test' && <Spinner size={12} />} Test
          </button>
          <button className="btn" disabled={!valid || !!busy} onClick={wrap('save', async () => { await save(); toast({ title: 'Saved', kind: 'success' }) })}>
            Save
          </button>
          <button
            className="btn primary"
            disabled={!valid || !!busy}
            onClick={wrap('connect', async () => {
              const s = await save()
              if (await ensureConnected(s.id)) launch('finder', { serverId: s.id, forceNew: true })
            })}
          >
            <Server size={12} /> {isNew ? 'Add & Connect' : 'Save & Connect'}
          </button>
        </div>
      </div>
    </div>
  )
}
