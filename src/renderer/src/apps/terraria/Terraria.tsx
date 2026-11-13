import { useEffect, useMemo, useState } from 'react'
import {
  Play, Square, RotateCw, Plus, RefreshCw, FolderOpen, Terminal as TermIcon, Copy, Ellipsis, Users, Cpu, Gauge, Send, Wrench,
  Server as ServerIcon, FolderSearch, TreePine, Globe2, Download, Trash2, Upload, ArrowUpCircle, KeyRound, FileCode, Search,
} from 'lucide-react'
import { api, shq } from '../../lib/api'
import { confirm, ensureConnected, prompt, toast, updateWindow, useStore, Win } from '../../lib/store'
import { useTr, scanTrHost, refreshTrDirs, addTrDir, removeTrDir } from '../../lib/tr/store'
import {
  defaultTrConfig, HAS_ICU, INSTALL_ICU, parseServerConfig, saveTrConfig, serializeServerConfig, TR_FILE, TR_SOFTWARE, TrConfig, TrServer, WORLD_DIR, writeTrManagement,
} from '../../lib/tr/server'
import { latestRelease, installScript } from '../../lib/tr/apis'
import { TR_GROUPS, TR_PROPS } from '../../lib/tr/config'
import { ctl, describeSchedule, MC_DIR, removeCron, run, type McServer } from '../../lib/mc/server'
import { formatBytes } from '../../lib/files'
import { openInEditor } from '../../lib/actions'
import { Toolbar } from '../../components/Window'
import { Spinner, Switch, useMenu } from '../../components/ui'
import { launch } from '../launch'
import { Ctx, Help, McCtx, Row, ScheduleEditor, Section, StatusPill, useCtx, useTaskRunner } from '../minecraft/common'
import { ConsoleTab } from '../minecraft/Minecraft'
import { BackupsTab } from '../minecraft/Panels'
import { PropControl } from '../minecraft/Settings'
import { DuplicateSheet, duplicateScript, type DuplicateOptions } from '../minecraft/Duplicate'
import { NewTerrariaServer } from './NewServer'
import { TrContentTab } from './Content'

type Tab = 'Overview' | 'Console' | 'Plugins' | 'Mods' | 'Worlds' | 'Backups' | 'Settings' | 'Help'
type Sel = { hostId: string; dir: string } | { new: true; hostId?: string } | null

/** The Terraria server behind the shared (Minecraft) context type. */
export const useTrCtx = () => {
  const c = useCtx()
  return { ...c, srv: c.srv as unknown as TrServer }
}

export function TrIcon({ software, size = 28 }: { software: string; size?: number }) {
  const color = TR_SOFTWARE[software as keyof typeof TR_SOFTWARE]?.color ?? '#8e8e93'
  return (
    <div style={{ width: size, height: size, borderRadius: size * 0.22, flexShrink: 0, background: `linear-gradient(180deg, ${color} 0 45%, #4caf50 45% 60%, #6b4423 60% 100%)`, boxShadow: 'inset 0 0 0 1px rgba(0,0,0,.15), inset 0 1px 0 rgba(255,255,255,.35)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <TreePine size={size * 0.55} color="#fff" strokeWidth={2.2} style={{ filter: 'drop-shadow(0 1px 1px rgba(0,0,0,.4))' }} />
    </div>
  )
}

export function Terraria({ win }: { win: Win }) {
  const servers = useStore((s) => s.servers)
  const conns = useStore((s) => s.conns)
  const tr = useTr((s) => s.servers)
  const scanning = useTr((s) => s.scanning)
  const [sel, setSel] = useState<Sel>(win.props.create ? { new: true, hostId: win.props.hostId } : null)
  const [tab, setTab] = useState<Tab>('Overview')
  const menu = useMenu()
  const sshHosts = servers.filter((s) => s.protocol === 'ssh')
  const connectedHosts = sshHosts.filter((s) => conns[s.id]?.status === 'connected')

  useEffect(() => {
    if (sel) return
    for (const h of connectedHosts) {
      const first = tr[h.id]?.[0]
      if (first) return setSel({ hostId: h.id, dir: first.dir })
    }
  }, [tr, connectedHosts.length]) // eslint-disable-line

  useEffect(() => {
    if (win.props.create) {
      setSel({ new: true, hostId: win.props.hostId })
      updateWindow(win.id, { props: { ...win.props, create: false } })
    }
  }, [win.props.create]) // eslint-disable-line

  const current = sel && !('new' in sel) ? tr[sel.hostId]?.find((s) => s.dir === sel.dir) : undefined
  const host = current ? servers.find((s) => s.id === current.hostId) : undefined

  const addFolder = async (hostId: string) => {
    const p = await prompt('Add Server Folder', '/home/', 'Folder with a Terraria server (TShock.Server, tModLoader or TerrariaServer)', 'Add')
    if (!p) return
    const dir = p.replace(/\/+$/, '')
    addTrDir(hostId, dir)
    const list = await scanTrHost(hostId)
    if (list.some((s) => s.dir === dir)) setSel({ hostId, dir })
    else toast({ title: 'No Terraria server found there', kind: 'error' })
  }

  return (
    <>
      <Toolbar>
        <div style={{ width: 84 }} />
        <div className="toolbar-title" style={{ flex: 1 }}>Terraria Servers</div>
        <button className="tb-btn" title="Scan connected servers again" onClick={() => connectedHosts.forEach((h) => scanTrHost(h.id))}><RefreshCw size={15} /></button>
        <button className="tb-btn" title="New Terraria Server" onClick={() => setSel({ new: true })}><Plus size={18} /></button>
      </Toolbar>
      <div className="split">
        <div className="sidebar" style={{ width: 230 }}>
          {connectedHosts.length === 0 && <div className="small muted" style={{ padding: 10, lineHeight: 1.5 }}>Connect to an SSH server to find or create Terraria servers.</div>}
          {connectedHosts.map((h) => (
            <div key={h.id}>
              <div className="sb-section">
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{h.name}</span>
                <span className="row" style={{ gap: 0 }}>
                  {scanning[h.id] && <Spinner size={10} />}
                  <button className="eject" style={{ opacity: 1 }} title="Add existing folder…" onClick={() => addFolder(h.id)}><FolderSearch size={12} /></button>
                </span>
              </div>
              {(tr[h.id] ?? []).map((s) => (
                <div
                  key={s.dir}
                  className={`sb-item ${current?.dir === s.dir && current?.hostId === s.hostId ? 'active' : ''}`}
                  style={{ height: 40 }}
                  onClick={() => setSel({ hostId: h.id, dir: s.dir })}
                  onContextMenu={(e) => menu.open(e, [
                    { label: 'Open in Finder', onClick: () => launch('finder', { serverId: h.id, forceNew: true, props: { path: s.dir } }) },
                    { label: 'Remove from List', onClick: () => { removeTrDir(h.id, s.dir); scanTrHost(h.id) } },
                  ])}
                >
                  <TrIcon software={s.config.software} size={24} />
                  <div className="grow">
                    <div style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.config.name}</div>
                    <div className="small muted">{TR_SOFTWARE[s.config.software]?.name} {s.config.version}</div>
                  </div>
                  <span className={`status-dot ${s.running ? 'connected' : 'disconnected'}`} />
                </div>
              ))}
              {!scanning[h.id] && (tr[h.id] ?? []).length === 0 && <div className="small muted" style={{ padding: '2px 10px 6px' }}>No servers found</div>}
            </div>
          ))}
          {sshHosts.filter((h) => conns[h.id]?.status !== 'connected').length > 0 && (
            <>
              <div className="sb-section">Not connected</div>
              {sshHosts.filter((h) => conns[h.id]?.status !== 'connected').map((h) => (
                <div key={h.id} className="sb-item" onClick={() => ensureConnected(h.id)} style={{ color: 'var(--text-2)' }}>
                  <ServerIcon size={15} className="ico" style={{ color: 'var(--text-3)' }} />
                  <span className="grow">{h.name}</span>
                  <span className="small">Connect</span>
                </div>
              ))}
            </>
          )}
          <div className="sb-item" style={{ marginTop: 8, color: 'var(--accent)' }} onClick={() => setSel({ new: true })}>
            <Plus size={15} className="ico" />
            <span className="grow">New Server…</span>
          </div>
        </div>
        <div className="grow" style={{ display: 'flex', flexDirection: 'column', background: 'var(--win-bg)', position: 'relative', minWidth: 0 }}>
          {sel && 'new' in sel ? (
            <NewTerrariaServer hostId={sel.hostId} onCancel={() => setSel(null)} onCreated={(hostId, dir) => { setSel({ hostId, dir }); setTab('Console') }} />
          ) : current && host ? (
            <ServerView key={current.hostId + current.dir} srv={current} hostName={host.name} hostAddr={host.host} tab={tab} setTab={setTab} onDeleted={() => setSel(null)} onSelect={(dir) => { setSel({ hostId: current.hostId, dir }); setTab('Overview') }} />
          ) : (
            <div className="empty">
              <TreePine size={44} strokeWidth={1.3} />
              <h3>Terraria Server Manager</h3>
              <div style={{ maxWidth: 400 }}>Run TShock, tModLoader or vanilla Terraria servers on your machines: worlds, plugins, Workshop mods, backups and automatic restarts.</div>
              <button className="btn primary lg" onClick={() => setSel({ new: true })}><Plus size={14} /> Create a Server</button>
            </div>
          )}
        </div>
      </div>
      {menu.el}
    </>
  )
}

// ---------------------------------------------------------------------------
const NONE: TrServer[] = []

function ServerView({ srv, hostName, hostAddr, tab, setTab, onDeleted, onSelect }: { srv: TrServer; hostName: string; hostAddr: string; tab: Tab; setTab: (t: Tab) => void; onDeleted: () => void; onSelect: (dir: string) => void }) {
  const host = useStore((s) => s.servers.find((x) => x.id === srv.hostId))!
  const runner = useTaskRunner(srv.hostId)
  const menu = useMenu()
  const [busy, setBusy] = useState('')
  const [dup, setDup] = useState(false)
  const hostServers = useTr((s) => s.servers[srv.hostId] ?? NONE)
  const c = srv.config
  const contentTab: Tab | null = TR_SOFTWARE[c.software].content === 'plugins' ? 'Plugins' : TR_SOFTWARE[c.software].content === 'mods' ? 'Mods' : null
  const tabs: Tab[] = ['Overview', 'Console', ...(contentTab ? [contentTab] : []), 'Worlds', 'Backups', 'Settings', 'Help']

  const reload = async () => { await refreshTrDirs(srv.hostId, [srv.dir]) }
  useEffect(() => {
    const t = setInterval(() => { if (!document.hidden) refreshTrDirs(srv.hostId, [srv.dir]).catch(() => {}) }, 6000)
    return () => clearInterval(t)
  }, [srv.hostId, srv.dir])

  const saveCfg = async (patch: Partial<TrConfig>) => {
    let base = c
    try { base = JSON.parse(await api.fs.readText(srv.hostId, `${srv.dir}/${MC_DIR}/${TR_FILE}`)) } catch { /* not managed */ }
    await saveTrConfig(srv.hostId, srv.dir, { ...base, ...patch })
    await reload()
  }

  const ctx: McCtx = { srv: srv as unknown as McServer, host, reload, task: runner.run, saveCfg: saveCfg as McCtx['saveCfg'], setTab: (t) => setTab(t as Tab) }

  const action = async (a: 'start' | 'stop' | 'restart' | 'kill') => {
    if (a === 'kill' && !(await confirm('Force kill the server?', 'The world will NOT be saved. Only use this if the server is frozen.', 'Kill', true))) return
    setBusy(a)
    try {
      if (srv.external) {
        await run(srv.hostId, `kill ${a === 'kill' ? '-9 ' : ''}${srv.pid}`)
        toast({ title: 'Stop signal sent' })
      } else {
        const r = await ctl(srv.hostId, srv.dir, a)
        const out = (r.stdout + r.stderr).trim()
        if (r.code !== 0 || /Failed|not found/i.test(out)) toast({ title: `Couldn't ${a} ${c.name}`, body: out.slice(-400), kind: 'error', action: { label: 'Console', run: () => setTab('Console') } })
        else if (a === 'start') setTab('Console')
      }
    } catch (e: any) {
      toast({ title: `Couldn't ${a} the server`, body: e.message, kind: 'error' })
    } finally {
      setBusy('')
      reload()
    }
  }

  const setup = async () => {
    setBusy('setup')
    try {
      // make sure there is a config with a world so the server starts unattended
      const scPath = `${srv.dir}/serverconfig.txt`
      const sc = await api.fs.readText(srv.hostId, scPath).catch(() => '')
      const v = parseServerConfig(sc)
      await run(srv.hostId, `mkdir -p ${shq(srv.dir + '/' + WORLD_DIR)}`)
      await api.fs.writeText(srv.hostId, scPath, serializeServerConfig(sc, {
        worldpath: v.worldpath || `${srv.dir}/${WORLD_DIR}`,
        world: v.world || `${srv.dir}/${WORLD_DIR}/World.wld`,
        autocreate: v.autocreate || '2',
        worldname: v.worldname || 'World',
        port: v.port || '7777',
        maxplayers: v.maxplayers || '8',
      }))
      await writeTrManagement(srv.hostId, srv.dir, c)
      toast({ title: 'Management enabled', body: `Helper scripts were added to ${srv.dir}/.sshos`, kind: 'success' })
      await reload()
    } catch (e: any) {
      toast({ title: 'Setup failed', body: e.message, kind: 'error' })
    } finally {
      setBusy('')
    }
  }

  const deleteServer = async () => {
    const typed = await prompt(`Delete “${c.name}” permanently?`, '', `This stops the server and deletes ${srv.dir} including all worlds and backups inside it. Type the server name (${c.name}) to confirm.`, 'Delete Forever', true)
    if (typed === null) return
    if (typed.trim() !== c.name) return toast({ title: 'Name did not match. Nothing was deleted.', kind: 'error' })
    setBusy('delete')
    try {
      if (srv.running && srv.managed && !srv.external) await ctl(srv.hostId, srv.dir, 'stop', '0')
      else if (srv.running && srv.pid) await run(srv.hostId, `kill ${srv.pid}; sleep 8`)
      await removeCron(srv.hostId, c.id)
      const r = await run(srv.hostId, `rm -rf -- ${shq(srv.dir)}`, 300000)
      if (r.code !== 0) throw new Error(r.stderr || 'rm failed')
      removeTrDir(srv.hostId, srv.dir)
      toast({ title: `Deleted ${c.name}`, kind: 'success' })
      onDeleted()
      await scanTrHost(srv.hostId)
    } catch (e: any) {
      toast({ title: 'Delete failed', body: e.message, kind: 'error' })
    } finally {
      setBusy('')
    }
  }

  const duplicate = async (o: DuplicateOptions) => {
    setDup(false)
    const live = srv.running && srv.managed && !srv.external
    const ctlPath = `${shq(srv.dir)}/.sshos/ctl.sh`
    const excludes = [
      'logs', 'tshock/logs', '.sshos/server.pid', '.sshos/mux', '.sshos/stdin', '.sshos/stop-requested', '.sshos/console.log', '.sshos/console.prev.log', '.sshos/backup.log',
      ...(o.includeBackups ? [] : [c.backups.dir && !c.backups.dir.startsWith('/') ? c.backups.dir : 'backups']),
      ...(o.includeWorlds ? [] : [WORLD_DIR, 'data/Worlds']),
    ]
    const r = await runner.run(`Duplicating ${c.name}`, duplicateScript(srv.dir, o.dir, excludes, live ? `sh ${ctlPath} cmd "save" >/dev/null; sleep 6` : ''))
    if (r.code !== 0) return
    try {
      const scPath = `${o.dir}/serverconfig.txt`
      const sc = await api.fs.readText(srv.hostId, scPath).catch(() => '')
      const v = parseServerConfig(sc)
      const world = (v.world || `${srv.dir}/${WORLD_DIR}/World.wld`).replace(srv.dir, o.dir)
      await run(srv.hostId, `mkdir -p ${shq(o.dir + '/' + WORLD_DIR)}`)
      await api.fs.writeText(srv.hostId, scPath, serializeServerConfig(sc, { port: String(o.port), world, worldpath: `${o.dir}/${WORLD_DIR}`, autocreate: v.autocreate || '2' }))
      if (srv.managed) {
        const fresh = defaultTrConfig({ name: o.name, software: c.software, version: c.version })
        await writeTrManagement(srv.hostId, o.dir, { ...c, id: fresh.id, name: o.name, session: fresh.session, createdAt: Date.now() })
        if (o.startAfter) await ctl(srv.hostId, o.dir, 'start')
      }
      addTrDir(srv.hostId, o.dir)
      await scanTrHost(srv.hostId)
      toast({ title: `Created “${o.name}”`, body: `${o.dir} · port ${o.port}`, kind: 'success' })
      onSelect(o.dir)
    } catch (e: any) {
      toast({ title: 'Copy made, but setup failed', body: e.message, kind: 'error' })
    }
  }

  const attach = () => launch('terminal', { serverId: srv.hostId, forceNew: true, props: { command: `cd ${shq(srv.dir)} && (tmux attach -t ${shq(c.session)} 2>/dev/null || screen -r ${shq(c.session)} 2>/dev/null || tail -f .sshos/console.log)` } })

  return (
    <Ctx.Provider value={ctx}>
      <div className="mc-header">
        <TrIcon software={c.software} size={44} />
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="row" style={{ gap: 8 }}>
            <b style={{ fontSize: 17, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</b>
            <StatusPill srv={srv as unknown as McServer} />
          </div>
          <div className="small muted" style={{ marginTop: 2 }}>
            {TR_SOFTWARE[c.software]?.name} {c.version}{c.terraria && c.software !== 'vanilla' ? ` · Terraria ${c.terraria}` : ''} · {hostName}:{srv.port} · <span className="mono">{srv.dir}</span>
          </div>
        </div>
        {(srv.managed || srv.external) && (
          <div className="row">
            {!srv.running ? (
              <button className="btn primary lg" disabled={!!busy || !srv.managed} onClick={() => action('start')}>{busy === 'start' ? <Spinner size={12} /> : <Play size={13} />} Start</button>
            ) : (
              <>
                <button className="btn lg" disabled={!!busy} onClick={() => action('stop')}>{busy === 'stop' ? <Spinner size={12} /> : <Square size={12} />} Stop</button>
                {!srv.external && <button className="btn lg" disabled={!!busy} onClick={() => action('restart')}>{busy === 'restart' ? <Spinner size={12} /> : <RotateCw size={13} />} Restart</button>}
              </>
            )}
          </div>
        )}
        <button className="tb-btn" onClick={(e) => menu.open(e, [
          { label: 'Open Folder in Finder', icon: <FolderOpen size={14} />, onClick: () => launch('finder', { serverId: srv.hostId, forceNew: true, props: { path: srv.dir } }) },
          { label: 'Terminal in Folder', icon: <TermIcon size={14} />, onClick: () => launch('terminal', { serverId: srv.hostId, forceNew: true, props: { cwd: srv.dir } }) },
          { label: 'Attach to Server Console', disabled: !srv.running || !srv.managed, onClick: attach },
          { separator: true },
          { label: 'Force Kill', danger: true, disabled: !srv.running, onClick: () => action('kill') },
          { label: srv.managed ? 'Reinstall Helper Scripts' : 'Set Up Management', onClick: setup },
          { separator: true },
          { label: 'Duplicate Server…', icon: <Copy size={14} />, onClick: () => setDup(true) },
          { label: 'Delete Server…', danger: true, onClick: deleteServer },
        ])}>
          <Ellipsis size={18} />
        </button>
      </div>

      {!srv.managed && (
        <div className="mc-banner">
          <Wrench size={18} />
          <div className="grow">
            <b>This server isn’t managed by SSH OS yet.</b>
            <div className="small">Set up management to start/stop it from here, run it in the background, schedule backups and restart it after crashes. This adds a .sshos folder and a world setting if none exists.</div>
          </div>
          <button className="btn primary" disabled={!!busy} onClick={setup}>{busy === 'setup' ? <Spinner size={12} /> : null} Set Up Management</button>
        </div>
      )}

      <div className="mc-tabs">
        {tabs.map((t) => <button key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>{t}</button>)}
      </div>
      <div className="grow" style={{ minHeight: 0, display: 'flex', flexDirection: 'column', position: 'relative' }}>
        {tab === 'Overview' && <Overview hostAddr={hostAddr} />}
        {tab === 'Console' && <ConsoleTab hint={c.software === 'tshock' ? 'Type a command, e.g. say hi, playing, /user group Steve superadmin — ↑ for history' : 'Type a command, e.g. say hi, playing, save, dawn — ↑ for history'} />}
        {(tab === 'Plugins' || tab === 'Mods') && <TrContentTab />}
        {tab === 'Worlds' && <WorldsTab />}
        {tab === 'Backups' && <BackupsTab />}
        {tab === 'Settings' && <SettingsTab onDelete={deleteServer} />}
        {tab === 'Help' && <TrHelp />}
      </div>
      {runner.el}
      {menu.el}
      {dup && (
        <DuplicateSheet hostId={srv.hostId} srcName={c.name} srcDir={srv.dir} usedPorts={hostServers.map((s) => s.port)} defaultPort={srv.port} worldsLabel="worlds" running={srv.running} onCancel={() => setDup(false)} onConfirm={duplicate} />
      )}
    </Ctx.Provider>
  )
}

// ---------------------------------------------------------------------------
function Overview({ hostAddr }: { hostAddr: string }) {
  const { srv, task, reload, setTab } = useTrCtx()
  const c = srv.config
  const [live, setLive] = useState<{ rss?: number; cpu?: number; etime?: string; ips: string[]; setupCode?: string; arch?: string; icu?: boolean } | null>(null)
  const [players, setPlayers] = useState<{ list: string[]; count: number } | null>(null)
  const [latest, setLatest] = useState<{ version: string; terraria?: string } | null | 'error'>(null)
  const [say, setSay] = useState('')
  const canCmd = srv.running && srv.managed && !srv.external

  useEffect(() => {
    let stop = false
    const tick = async () => {
      try {
        const r = await run(srv.hostId, `hostname -I 2>/dev/null | tr ' ' '\\n' | grep -v ':' | head -3; echo '@@'
${srv.pid ? `ps -o rss=,pcpu=,etime= -p ${srv.pid} 2>/dev/null` : 'true'}; echo '@@'
cat ${shq(srv.dir + '/tshock/setup-code.txt')} 2>/dev/null | head -1; echo '@@'; uname -m; echo '@@'; ${HAS_ICU}`)
        const [ips, ps, code, arch, icu] = r.stdout.split('@@').map((x) => x.trim())
        const [rss, cpu, etime] = ps.split(/\s+/)
        if (!stop) setLive({ ips: ips.split('\n').filter(Boolean), rss: rss ? +rss * 1024 : undefined, cpu: cpu ? +cpu : undefined, etime, setupCode: code.match(/\d{4,}/)?.[0], arch, icu: icu === 'icu' })
      } catch { /* ignore */ }
      if (!stop) setTimeout(tick, 6000)
    }
    tick()
    return () => { stop = true }
  }, [srv.hostId, srv.dir, srv.pid]) // eslint-disable-line

  useEffect(() => {
    if (!live?.arch) return
    latestRelease(c.software, live.arch).then((r) => setLatest({ version: r.version, terraria: r.terraria })).catch(() => setLatest('error'))
  }, [live?.arch, c.software])

  const send = async (cmd: string, quiet = false) => {
    const r = await ctl(srv.hostId, srv.dir, 'cmd', cmd)
    if (r.code !== 0) toast({ title: 'Command failed', body: r.stdout + r.stderr, kind: 'error' })
    else if (!quiet) toast({ title: `Sent: ${cmd}`, kind: 'success' })
  }

  const who = async () => {
    await send('playing', true)
    await new Promise((r) => setTimeout(r, 1200))
    const t = await run(srv.hostId, `tail -n 40 ${shq(srv.dir + '/.sshos/console.log')} | sed 's/\\x1b\\[[0-9;]*m//g'`)
    const lines = t.stdout.split('\n')
    let idx = -1
    for (let i = lines.length - 1; i >= 0; i--) if (/players? connected|Online Players/i.test(lines[i])) { idx = i; break }
    if (idx < 0) return setPlayers({ list: [], count: 0 })
    const ts = lines[idx].match(/Online Players \((\d+)\/\d+\):?\s*(.*)/i)
    if (ts) return setPlayers({ count: +ts[1], list: ts[2].split(',').map((x) => x.trim()).filter(Boolean) })
    const n = lines[idx].match(/(\d+) players? connected/i)?.[1]
    const names: string[] = []
    for (let i = idx - 1; i >= 0 && names.length < (+(n ?? 0)); i--) { const m = lines[i].match(/^:?\s*([^\s(][^(]*?)\s*\(\d+\.\d+\.\d+\.\d+/); if (m) names.unshift(m[1]); else break }
    setPlayers({ count: +(n ?? 0), list: names })
  }

  const update = async () => {
    if (!live?.arch || !latest || latest === 'error') return
    if (!(await confirm(`Update ${TR_SOFTWARE[c.software].name} to ${latest.version}?`, `Worlds${c.software === 'tshock' ? ', the tshock/ folder and plugins' : c.software === 'tmodloader' ? ' and mods' : ''} are kept. ${srv.running ? 'The server is stopped and started again.' : ''} A world backup is made first.`, 'Update'))) return
    const rel = await latestRelease(c.software, live.arch)
    const was = srv.running && !srv.external
    const r = await task(`Updating to ${rel.version}`, `${was ? `sh ${shq(srv.dir)}/.sshos/ctl.sh stop 10 &&` : ''} ${srv.managed ? `sh ${shq(srv.dir)}/.sshos/backup.sh worlds &&` : ''} true
${installScript(c.software, rel, srv.dir)}
${was ? `sh ${shq(srv.dir)}/.sshos/ctl.sh start` : ''}`)
    if (r.code === 0 && srv.managed) {
      const base = JSON.parse(await api.fs.readText(srv.hostId, `${srv.dir}/${MC_DIR}/${TR_FILE}`))
      await saveTrConfig(srv.hostId, srv.dir, { ...base, version: rel.version, terraria: rel.terraria ?? base.terraria })
    }
    reload()
  }

  const addr = (h: string) => `${h}:${srv.port}`
  const upToDate = latest && latest !== 'error' && latest.version === c.version
  return (
    <div className="grow scroll pad">
      {live && live.icu === false && c.software !== 'vanilla' && (
        <div className="card" style={{ marginBottom: 14, borderLeft: '3px solid var(--red)' }}>
          <b>Terraria needs the ICU library</b>
          <div className="small" style={{ marginTop: 4, lineHeight: 1.5 }}>
            The server crashes at startup with “invalid culture identifier” until libicu is installed. This needs administrator rights once.
            <button className="btn primary" style={{ marginLeft: 8 }} onClick={() => launch('terminal', { serverId: srv.hostId, forceNew: true, props: { command: INSTALL_ICU } })}>Install in Terminal</button>
          </div>
        </div>
      )}
      {live?.setupCode && c.software === 'tshock' && (
        <div className="card" style={{ marginBottom: 14, borderLeft: '3px solid var(--accent)' }}>
          <div className="row"><KeyRound size={16} /><b>Become the server admin</b></div>
          <div className="small" style={{ marginTop: 4, lineHeight: 1.5 }}>
            Join the server in Terraria and type <span className="mono kbd">/setup {live.setupCode}</span> in chat, then <span className="mono kbd">/user add NAME PASSWORD owner</span> and <span className="mono kbd">/login</span>. The code disappears once an owner exists.
            <button className="btn" style={{ marginLeft: 8 }} onClick={() => api.copyText(`/setup ${live.setupCode}`)}><Copy size={11} /> Copy</button>
          </div>
        </div>
      )}
      <div className="mc-cards">
        <div className="mc-card">
          <div className="mc-card-h"><Users size={14} /> Players</div>
          <div className="mc-big">{players ? `${players.count} / ${srv.maxPlayers}` : srv.running ? `– / ${srv.maxPlayers}` : '—'}</div>
          <div className="small muted row" style={{ justifyContent: 'space-between' }}>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{players ? (players.list.join(', ') || 'Nobody online') : srv.running ? 'Click refresh to see who is online' : 'Server is stopped'}</span>
            {canCmd && <button className="tb-btn" style={{ height: 18 }} title="Who is online?" onClick={who}><RefreshCw size={11} /></button>}
          </div>
        </div>
        <div className="mc-card">
          <div className="mc-card-h"><Cpu size={14} /> Process</div>
          <div className="mc-big">{srv.running && live?.rss ? (live.rss > 1024 ** 3 ? `${(live.rss / 1024 ** 3).toFixed(1)} GB` : `${Math.round(live.rss / 1024 ** 2)} MB`) : '—'}</div>
          <div className="small muted">{srv.running ? `CPU ${live?.cpu ?? '–'}% · up ${live?.etime ?? '–'}` : 'Not running'}</div>
        </div>
        <div className="mc-card">
          <div className="mc-card-h"><Gauge size={14} /> Version</div>
          <div className="mc-big" style={{ fontSize: 18 }}>{TR_SOFTWARE[c.software].name} {c.version || '?'}</div>
          <div className="small muted">
            {latest === null ? 'Checking for updates…' : latest === 'error' ? 'Could not check for updates' : upToDate ? 'Up to date' : (
              <span className="row" style={{ gap: 6 }}><span style={{ color: 'var(--accent)' }}>{latest.version} available</span>{srv.managed && <button className="btn" style={{ height: 20 }} onClick={update}><ArrowUpCircle size={11} /> Update</button>}</span>
            )}
          </div>
        </div>
      </div>
      <div className="group-box" style={{ marginTop: 14 }}>
        <div className="group-row">
          <div>
            <div className="row" style={{ gap: 4 }}><b>Connect address</b><Help title="Connecting" text="In Terraria: Multiplayer → Join via IP, enter the address, then the port. For friends outside your network, forward the port on your router (TCP) and give them your public IP." /></div>
            <div className="small muted">Multiplayer → Join via IP</div>
          </div>
          <div className="row" style={{ flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            {[...(live?.ips ?? []), hostAddr].filter((v, i, a) => a.indexOf(v) === i).map((ip) => (
              <button key={ip} className="btn mono" onClick={() => { api.copyText(addr(ip)); toast({ title: 'Copied', body: addr(ip) }) }}>{addr(ip)} <Copy size={11} /></button>
            ))}
          </div>
        </div>
        <div className="group-row"><span>World</span><span className="muted mono small">{srv.world ? srv.world.split('/').pop() : '—'}</span></div>
        <div className="group-row">
          <span>Automation</span>
          <span className="row small" style={{ flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            <span className="badge">{c.autoStart ? 'Starts on boot' : 'No autostart'}</span>
            <span className="badge">{c.restartOnCrash ? 'Restarts on crash' : 'No crash restart'}</span>
            <span className="badge">Backups: {describeSchedule(c.backups.schedule)}</span>
            <button className="btn" onClick={() => setTab('Settings')}>Edit</button>
          </span>
        </div>
      </div>
      <div className="group-box" style={{ marginTop: 14 }}>
        <div className="group-row">
          <span>Broadcast message</span>
          <div className="row">
            <input className="input" style={{ width: 300 }} disabled={!canCmd} placeholder={canCmd ? 'Hello everyone!' : 'Server must be running'} value={say} onChange={(e) => setSay(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && say) { send('say ' + say); setSay('') } }} />
            <button className="btn" disabled={!canCmd || !say} onClick={() => { send('say ' + say); setSay('') }}><Send size={12} /></button>
          </div>
        </div>
        <div className="group-row">
          <span>Quick actions</span>
          <div className="row" style={{ flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            {[['Save world', 'save'], ['Dawn', 'dawn'], ['Noon', 'noon'], ['Dusk', 'dusk'], ['Midnight', 'midnight'], ['Settle liquids', 'settle']].map(([l, cmd]) => (
              <button key={cmd} className="btn" disabled={!canCmd} onClick={() => send(cmd)}>{l}</button>
            ))}
            <button className="btn" disabled={!srv.managed} onClick={() => task('Backup', `sh ${shq(srv.dir)}/.sshos/backup.sh`)}>Backup now</button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
function WorldsTab() {
  const { srv, task, reload } = useTrCtx()
  const [worlds, setWorlds] = useState<{ file: string; size: number; time: number }[] | null>(null)
  const [nw, setNw] = useState({ name: '', size: '2', difficulty: '0', seed: '' })
  const sc = `${srv.dir}/serverconfig.txt`

  const load = async () => {
    const r = await run(srv.hostId, `cd ${shq(srv.dir)} && for f in ${WORLD_DIR}/*.wld data/Worlds/*.wld; do [ -f "$f" ] && echo "$f|$(stat -c '%s|%Y' "$f")"; done; true`)
    setWorlds(r.stdout.split('\n').filter(Boolean).map((l) => { const [file, size, time] = l.split('|'); return { file, size: +size, time: +time * 1000 } }))
  }
  useEffect(() => { load() }, [srv.dir]) // eslint-disable-line

  const setConfig = async (values: Record<string, string>) => {
    const t = await api.fs.readText(srv.hostId, sc).catch(() => '')
    await api.fs.writeText(srv.hostId, sc, serializeServerConfig(t, values))
    await reload()
  }

  const activate = async (file: string) => {
    await setConfig({ world: `${srv.dir}/${file}` })
    toast({ title: `${file.split('/').pop()} will load on the next start`, body: srv.running ? 'Restart the server to switch worlds.' : undefined, kind: 'success' })
  }

  const create = async () => {
    const name = nw.name.trim()
    if (!name) return
    const file = name.replace(/[^\w -]+/g, '').replace(/\s+/g, '_') || 'World'
    if (worlds?.some((w) => w.file.endsWith(`/${file}.wld`))) return toast({ title: 'A world with that name exists', kind: 'error' })
    await setConfig({ world: `${srv.dir}/${WORLD_DIR}/${file}.wld`, autocreate: nw.size, worldname: name, difficulty: nw.difficulty, seed: nw.seed.trim() })
    toast({ title: `“${name}” is created on the next start`, body: srv.running ? 'Restart the server to generate it (takes a minute).' : 'Start the server to generate it.', kind: 'success' })
    setNw({ name: '', size: '2', difficulty: '0', seed: '' })
  }

  const del = async (file: string) => {
    if (srv.world.endsWith(file) && srv.running) return toast({ title: 'Stop the server first', kind: 'error' })
    if (!(await confirm(`Delete ${file.split('/').pop()}?`, 'The world file and its backup copy (.bak) are deleted permanently.', 'Delete', true))) return
    await task('Deleting world', `cd ${shq(srv.dir)} && rm -f -- ${shq(file)} ${shq(file + '.bak')} ${shq(file.replace(/\.wld$/, '.twld'))} && echo Deleted`)
    load()
  }

  return (
    <div className="grow scroll pad" style={{ maxWidth: 900, width: '100%', margin: '0 auto' }}>
      <Section title="Worlds" help="World files (.wld) in the worlds folder. The active world is set in serverconfig.txt (world=)." right={
        <div className="row">
          <button className="btn" onClick={load}><RefreshCw size={12} /></button>
          <button className="btn" onClick={async () => { if (await api.fs.uploadDialog(srv.hostId, `${srv.dir}/${WORLD_DIR}`)) load() }}><Upload size={12} /> Upload .wld…</button>
        </div>
      }>
        {worlds === null ? <div className="group-row"><Spinner size={12} /></div> : worlds.length === 0 ? <div className="group-row muted">No world yet. One is generated on the first start.</div> : worlds.map((w) => {
          const active = srv.world === `${srv.dir}/${w.file}` || srv.world.endsWith('/' + w.file)
          return (
            <div key={w.file} className="group-row">
              <div className="row">
                <Globe2 size={18} style={{ color: active ? 'var(--green)' : 'var(--text-3)' }} />
                <div>
                  <div className="row" style={{ gap: 6 }}><b>{w.file.split('/').pop()?.replace(/\.wld$/, '')}</b>{active && <span className="badge" style={{ color: 'var(--green)' }}>Active</span>}</div>
                  <div className="small muted">{formatBytes(w.size)} · saved {new Date(w.time).toLocaleString()}</div>
                </div>
              </div>
              <div className="row">
                {!active && <button className="btn" onClick={() => activate(w.file)}><Play size={11} /> Make Active</button>}
                <button className="btn" onClick={() => api.fs.download(srv.hostId, [{ path: `${srv.dir}/${w.file}`, isDir: false }])}><Download size={11} /> Download</button>
                {!active && <button className="tb-btn" title="Delete" onClick={() => del(w.file)}><Trash2 size={13} /></button>}
              </div>
            </div>
          )
        })}
      </Section>
      <Section title="New world" help="Sets the world in serverconfig.txt; the server generates it on its next start.">
        <Row label="Name"><input className="input" style={{ width: 240 }} placeholder="My World" value={nw.name} onChange={(e) => setNw({ ...nw, name: e.target.value })} /></Row>
        <Row label="Size" help="Small fits ~1–4 players, Medium ~4–8, Large 8+.">
          <select className="select" style={{ width: 160 }} value={nw.size} onChange={(e) => setNw({ ...nw, size: e.target.value })}><option value="1">Small</option><option value="2">Medium</option><option value="3">Large</option></select>
        </Row>
        <Row label="Difficulty">
          <select className="select" style={{ width: 160 }} value={nw.difficulty} onChange={(e) => setNw({ ...nw, difficulty: e.target.value })}><option value="0">Classic</option><option value="1">Expert</option><option value="2">Master</option><option value="3">Journey</option></select>
        </Row>
        <Row label="Seed" help="Leave empty for random. Secret seeds work (e.g. “for the worthy”)."><input className="input" style={{ width: 240 }} value={nw.seed} onChange={(e) => setNw({ ...nw, seed: e.target.value })} /></Row>
        <div className="row" style={{ justifyContent: 'flex-end', padding: '8px 0' }}><button className="btn primary" disabled={!nw.name.trim()} onClick={create}><Plus size={12} /> Create on Next Start</button></div>
      </Section>
    </div>
  )
}

// ---------------------------------------------------------------------------
const CONFIG_FILES = [
  { path: 'serverconfig.txt', help: 'Core server settings (also editable above).' },
  { path: 'tshock/config.json', help: 'TShock: server name, spawn protection, anti-cheat, permissions, backups and more.' },
  { path: 'tshock/sscconfig.json', help: 'TShock server-side characters (inventories stored on the server).' },
  { path: 'tshock/motd.txt', help: 'TShock message of the day.' },
  { path: 'tshock/rules.txt', help: 'TShock /rules text.' },
  { path: 'data/Mods/enabled.json', help: 'tModLoader: which mods are enabled.' },
  { path: 'banlist.txt', help: 'Vanilla ban list.' },
]

function SettingsTab({ onDelete }: { onDelete: () => void }) {
  const { srv, saveCfg } = useTrCtx()
  const c = srv.config
  const [orig, setOrig] = useState<string | null>(null)
  const [values, setValues] = useState<Record<string, string>>({})
  const [saved, setSaved] = useState<Record<string, string>>({})
  const [q, setQ] = useState('')
  const [exists, setExists] = useState<Set<string>>(new Set())
  const path = `${srv.dir}/serverconfig.txt`

  const load = async () => {
    const t = await api.fs.readText(srv.hostId, path).catch(() => '')
    setOrig(t)
    const v = parseServerConfig(t)
    setValues(v)
    setSaved(v)
    const r = await run(srv.hostId, `cd ${shq(srv.dir)} && for f in ${CONFIG_FILES.map((f) => shq(f.path)).join(' ')}; do [ -f "$f" ] && echo "$f"; done; true`)
    setExists(new Set(r.stdout.split('\n').filter(Boolean)))
  }
  useEffect(() => { load() }, [srv.dir]) // eslint-disable-line

  const dirty = Object.keys({ ...values, ...saved }).filter((k) => (values[k] ?? '') !== (saved[k] ?? ''))
  const save = async () => {
    await api.fs.writeText(srv.hostId, path, serializeServerConfig(orig ?? '', values))
    toast({ title: 'serverconfig.txt saved', body: srv.running ? 'Restart the server to apply.' : undefined, kind: 'success' })
    load()
  }
  const match = (k: string, label: string, help: string) => !q || `${k} ${label} ${help}`.toLowerCase().includes(q.toLowerCase())
  const known = new Set(TR_PROPS.map((p) => p.key))
  const unknown = useMemo(() => Object.keys(values).filter((k) => !known.has(k)), [values]) // eslint-disable-line

  if (orig === null) return <div className="empty"><Spinner size={22} /></div>
  return (
    <>
      <div className="row" style={{ padding: '8px 16px', borderBottom: '1px solid var(--border)' }}>
        <div className="search" style={{ width: 260 }}><Search size={13} /><input placeholder="Search settings and help" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <div className="grow small muted">{dirty.length ? `${dirty.length} unsaved change${dirty.length > 1 ? 's' : ''}` : 'Changes apply after restarting the server'}</div>
        <button className="btn" onClick={() => openInEditor(srv.hostId, path)}><FileCode size={12} /> Edit as Text</button>
        <button className="btn primary" disabled={!dirty.length} onClick={save}>Save</button>
      </div>
      <div className="grow scroll pad" style={{ maxWidth: 860, width: '100%', margin: '0 auto' }}>
        {TR_GROUPS.map((g) => {
          const defs = TR_PROPS.filter((p) => p.group === g && match(p.key, p.label, p.help))
          if (!defs.length) return null
          return (
            <Section key={g} title={`serverconfig.txt · ${g}`}>
              {defs.map((d) => (
                <Row key={d.key} label={<span>{d.label}{(values[d.key] ?? '') !== (saved[d.key] ?? '') && <span style={{ color: 'var(--accent)' }}> •</span>}</span>} help={`${d.help}\n\nKey: ${d.key}`} sub={<span className="mono">{d.key}{!(d.key in values) ? ' (not set, using default)' : ''}</span>}>
                  <PropControl def={d} value={values[d.key] ?? d.def} onChange={(v) => setValues((x) => ({ ...x, [d.key]: v }))} />
                </Row>
              ))}
            </Section>
          )
        })}
        {unknown.length > 0 && !q && (
          <Section title="Other settings">
            {unknown.map((k) => <Row key={k} label={<span className="mono">{k}</span>}><input className="input" style={{ width: 300 }} value={values[k]} onChange={(e) => setValues((x) => ({ ...x, [k]: e.target.value }))} /></Row>)}
          </Section>
        )}
        {srv.managed && !q && (
          <Section title="Automation">
            <Row label="Start when the machine boots" help="Adds an @reboot entry to your crontab."><Switch on={c.autoStart} onChange={(v) => saveCfg({ autoStart: v })} /></Row>
            <Row label="Restart after a crash"><Switch on={c.restartOnCrash} onChange={(v) => saveCfg({ restartOnCrash: v })} /></Row>
            <Row label="Scheduled restart" sub={describeSchedule(c.restartSchedule)}><ScheduleEditor value={c.restartSchedule} onChange={(s) => saveCfg({ restartSchedule: s })} /></Row>
            <Row label="Back up worlds" sub={describeSchedule(c.backups.schedule)}><ScheduleEditor value={c.backups.schedule} onChange={(s) => saveCfg({ backups: { ...c.backups, schedule: s } })} /></Row>
            <Row label="Keep newest"><input className="input" type="number" min={1} style={{ width: 70 }} value={c.backups.keep} onChange={(e) => saveCfg({ backups: { ...c.backups, keep: +e.target.value || 1 } })} /> backups</Row>
            <Row label="Warn players before stopping"><input className="input" type="number" min={0} style={{ width: 70 }} value={c.stopWarnSeconds} onChange={(e) => saveCfg({ stopWarnSeconds: +e.target.value })} /> s</Row>
          </Section>
        )}
        {!q && (
          <Section title="Configuration files" help="Opens the file in the Code Editor. Most changes need a restart.">
            {CONFIG_FILES.filter((f) => exists.has(f.path)).map((f) => (
              <Row key={f.path} label={<span className="mono">{f.path}</span>} sub={f.help}><button className="btn" onClick={() => openInEditor(srv.hostId, `${srv.dir}/${f.path}`)}><FileCode size={12} /> Edit</button></Row>
            ))}
          </Section>
        )}
        {!q && (
          <Section title="Danger zone">
            <Row label="Delete this server" sub="Stops it, removes its schedules and deletes the folder including worlds."><button className="btn danger" onClick={onDelete}><Trash2 size={12} /> Delete Server…</button></Row>
          </Section>
        )}
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
const TR_HELP: { title: string; body: string[] }[] = [
  { title: 'Getting started', body: [
    'SSH OS finds Terraria servers in your home folder, /opt, /srv, /home, /var/games, /mnt and /data (TShock, tModLoader or the official server). Click + to create one.',
    'TShock is recommended: it plays exactly like normal Terraria, adds admin tools and plugins, and runs on x86_64 and ARM (Raspberry Pi).',
    'On the first TShock start, the Overview shows a setup code. Join the server, type /setup CODE in chat and create your owner account.',
  ] },
  { title: 'How players connect', body: [
    'In Terraria: Multiplayer → Join via IP → enter the address, then the port (7777 by default).',
    'For players outside your network, forward the TCP port on your router to this machine and give them your public IP. If the machine has a firewall: sudo ufw allow 7777/tcp.',
    'Every server on the same machine needs its own port.',
  ] },
  { title: 'Plugins (TShock)', body: [
    'Plugins are .dll files in ServerPlugins/. The Plugins tab installs them from GitHub releases of projects tagged “tshock-plugin”, and can update them.',
    'Plugins are built against a TShock version. SSH OS warns when a plugin looks like it was built for an older TShock (a common cause of startup errors).',
    'Plugin settings live in the tshock/ folder (JSON). Use the Config button next to a plugin.',
  ] },
  { title: 'Mods (tModLoader)', body: [
    'Mods come from the Steam Workshop and are downloaded with SteamCMD (installed automatically into ~/.sshos/steamcmd). SteamCMD only runs on x86_64 servers.',
    'Every player needs tModLoader; matching mods download automatically when they join.',
    'Workshop items are tagged with the tModLoader version they support (e.g. 1.4.4). Mods without the current tag are marked as not compatible.',
  ] },
  { title: 'Resource packs', body: [
    'Terraria resource packs are installed by each player in the game (Settings → Resource Packs); a server cannot send them. Modded servers can use mods that change textures instead.',
  ] },
  { title: 'Players & server size', body: [
    'Terraria servers are light: TShock uses ~0.5–1 GB, tModLoader with big mods 2–4 GB. World size matters more than player count: Large worlds use more memory and take longer to save.',
    'NPC stream (in Settings) trades bandwidth for smoother enemy movement.',
  ] },
  { title: 'Backups & duplicates', body: [
    'Backups archive the worlds (and TShock data). While running, the server is told to save first. Restoring keeps a safety copy of the current worlds.',
    'Duplicate (… menu) makes an independent copy with its own port: useful for testing plugin updates.',
  ] },
]

function TrHelp() {
  const [open, setOpen] = useState(0)
  return (
    <div className="split">
      <div className="sidebar" style={{ width: 220 }}>
        {TR_HELP.map((a, i) => <div key={a.title} className={`sb-item ${open === i ? 'active' : ''}`} onClick={() => setOpen(i)}><span className="grow">{a.title}</span></div>)}
        <div className="sb-section">Links</div>
        {[['TShock docs', 'https://ikebukuro.tshock.co/'], ['tModLoader wiki', 'https://github.com/tModLoader/tModLoader/wiki'], ['Terraria Wiki: server', 'https://terraria.wiki.gg/wiki/Server']].map(([l, u]) => (
          <div key={u} className="sb-item" onClick={() => api.openExternal(u)}><span className="grow" style={{ color: 'var(--accent)' }}>{l}</span></div>
        ))}
      </div>
      <div className="grow scroll pad help-article" style={{ maxWidth: 720 }}>
        <h2>{TR_HELP[open].title}</h2>
        {TR_HELP[open].body.map((p, i) => <p key={i}>{p}</p>)}
      </div>
    </div>
  )
}
