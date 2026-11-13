import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Play, Square, RotateCw, Plus, RefreshCw, FolderOpen, Terminal as TermIcon, Copy, Ellipsis, Pickaxe, Users, Cpu, HardDrive,
  Gauge, Send, Wrench, Server as ServerIcon, FolderSearch,
} from 'lucide-react'
import { api, shq } from '../../lib/api'
import { confirm, ensureConnected, prompt, toast, updateWindow, useStore, Win } from '../../lib/store'
import { useMc, scanHost, refreshDirs, addExtraDir, removeExtraDir } from '../../lib/mc/store'
import { ctl, defaultConfig, describeSchedule, MC_DIR, McConfig, McServer, removeCron, run, saveConfig, SLP_PY, writeManagement } from '../../lib/mc/server'
import { serializeProps } from '../../lib/mc/properties'
import { DuplicateSheet, duplicateScript, type DuplicateOptions } from './Duplicate'
import { SOFTWARE } from '../../lib/mc/apis'
import { Toolbar } from '../../components/Window'
import { Spinner, useMenu } from '../../components/ui'
import { launch } from '../launch'
import { Ctx, McCtx, StatusPill, useCtx, useTaskRunner, Help } from './common'
import { NewServer } from './NewServer'
import { ContentTab } from './Content'
import { SettingsTab } from './Settings'
import { PlayersTab, WorldsTab, BackupsTab, UpdatesTab, HelpTab } from './Panels'
import { WebsiteTab } from './Website'

const TABS = ['Overview', 'Console', 'Players', 'Content', 'Worlds', 'Backups', 'Updates', 'Website', 'Settings', 'Help'] as const
type Tab = (typeof TABS)[number]

type Sel = { hostId: string; dir: string } | { new: true; hostId?: string } | null

export function Minecraft({ win }: { win: Win }) {
  const servers = useStore((s) => s.servers)
  const conns = useStore((s) => s.conns)
  const mc = useMc((s) => s.servers)
  const scanning = useMc((s) => s.scanning)
  const [sel, setSel] = useState<Sel>(win.props.create ? { new: true, hostId: win.props.hostId } : null)
  const [tab, setTab] = useState<Tab>('Overview')
  const menu = useMenu()

  const sshHosts = servers.filter((s) => s.protocol === 'ssh')
  const connectedHosts = sshHosts.filter((s) => conns[s.id]?.status === 'connected')

  // pick first server automatically
  useEffect(() => {
    if (sel) return
    for (const h of connectedHosts) {
      const first = mc[h.id]?.[0]
      if (first) return setSel({ hostId: h.id, dir: first.dir })
    }
  }, [mc, connectedHosts.length]) // eslint-disable-line

  useEffect(() => {
    if (win.props.create) {
      setSel({ new: true, hostId: win.props.hostId })
      updateWindow(win.id, { props: { ...win.props, create: false } })
    }
  }, [win.props.create]) // eslint-disable-line

  const current = sel && !('new' in sel) ? mc[sel.hostId]?.find((s) => s.dir === sel.dir) : undefined
  const host = current ? servers.find((s) => s.id === current.hostId) : undefined

  const addFolder = async (hostId: string) => {
    const p = await prompt('Add Server Folder', '/home/', 'Path of a folder containing server.properties (or where a server jar lives)', 'Add')
    if (!p) return
    const dir = p.replace(/\/+$/, '')
    addExtraDir(hostId, dir)
    const list = await scanHost(hostId)
    if (list.some((s) => s.dir === dir)) setSel({ hostId, dir })
    else toast({ title: 'No server found there', body: 'The folder needs a server.properties file. Start the server once to create it, or create a new server.', kind: 'error' })
  }

  return (
    <>
      <Toolbar>
        <div style={{ width: 84 }} />
        <div className="toolbar-title" style={{ flex: 1 }}>Minecraft Servers</div>
        <button className="tb-btn" title="Scan connected servers again" onClick={() => connectedHosts.forEach((h) => scanHost(h.id))}>
          <RefreshCw size={15} />
        </button>
        <button className="tb-btn" title="New Minecraft Server" onClick={() => setSel({ new: true })}>
          <Plus size={18} />
        </button>
      </Toolbar>
      <div className="split">
        <div className="sidebar" style={{ width: 230 }}>
          {connectedHosts.length === 0 && (
            <div className="small muted" style={{ padding: 10, lineHeight: 1.5 }}>
              Connect to an SSH server to find or create Minecraft servers.
            </div>
          )}
          {connectedHosts.map((h) => (
            <div key={h.id}>
              <div className="sb-section">
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{h.name}</span>
                <span className="row" style={{ gap: 0 }}>
                  {scanning[h.id] && <Spinner size={10} />}
                  <button className="eject" style={{ opacity: 1 }} title="Add existing folder…" onClick={() => addFolder(h.id)}>
                    <FolderSearch size={12} />
                  </button>
                </span>
              </div>
              {(mc[h.id] ?? []).map((s) => {
                const active = current?.dir === s.dir && current?.hostId === s.hostId
                return (
                  <div
                    key={s.dir}
                    className={`sb-item ${active ? 'active' : ''}`}
                    style={{ height: 40 }}
                    onClick={() => setSel({ hostId: h.id, dir: s.dir })}
                    onContextMenu={(e) =>
                      menu.open(e, [
                        { label: 'Open in Finder', onClick: () => launch('finder', { serverId: h.id, forceNew: true, props: { path: s.dir } }) },
                        { label: 'Remove from List', onClick: () => { removeExtraDir(h.id, s.dir); scanHost(h.id) } },
                      ])
                    }
                  >
                    <McIcon software={s.config.software} size={24} />
                    <div className="grow">
                      <div style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.config.name}</div>
                      <div className="small muted" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {SOFTWARE[s.config.software]?.name} {s.config.mcVersion}
                      </div>
                    </div>
                    <span className={`status-dot ${s.running ? 'connected' : 'disconnected'}`} />
                  </div>
                )
              })}
              {!scanning[h.id] && (mc[h.id] ?? []).length === 0 && <div className="small muted" style={{ padding: '2px 10px 6px' }}>No servers found</div>}
            </div>
          ))}
          {sshHosts.filter((h) => conns[h.id]?.status !== 'connected').length > 0 && (
            <>
              <div className="sb-section">Not connected</div>
              {sshHosts
                .filter((h) => conns[h.id]?.status !== 'connected')
                .map((h) => (
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
            <NewServer
              hostId={sel.hostId}
              onCancel={() => setSel(null)}
              onCreated={(hostId, dir) => {
                setSel({ hostId, dir })
                setTab('Console')
              }}
            />
          ) : current && host ? (
            <ServerView key={current.hostId + current.dir} srv={current} hostName={host.name} tab={tab} setTab={setTab} onDeleted={() => setSel(null)} onSelect={(dir) => { setSel({ hostId: current.hostId, dir }); setTab('Overview') }} />
          ) : (
            <div className="empty">
              <Pickaxe size={44} strokeWidth={1.3} />
              <h3>Minecraft Server Manager</h3>
              <div style={{ maxWidth: 380 }}>
                Manage Java Edition servers on your machines: start and stop them, edit every setting, install plugins and mods from Modrinth, Hangar and SpigotMC, schedule backups and keep everything up to date.
              </div>
              <button className="btn primary lg" onClick={() => setSel({ new: true })}><Plus size={14} /> Create a Server</button>
            </div>
          )}
        </div>
      </div>
      {menu.el}
    </>
  )
}

export function McIcon({ software, size = 28 }: { software: string; size?: number }) {
  const color = SOFTWARE[software as keyof typeof SOFTWARE]?.color ?? '#8e8e93'
  return (
    <div
      style={{
        width: size, height: size, borderRadius: size * 0.22, flexShrink: 0,
        background: `linear-gradient(180deg, ${color} 0 38%, #7a5230 38% 100%)`,
        boxShadow: 'inset 0 0 0 1px rgba(0,0,0,.15), inset 0 1px 0 rgba(255,255,255,.35)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      <Pickaxe size={size * 0.55} color="#fff" strokeWidth={2.2} style={{ filter: 'drop-shadow(0 1px 1px rgba(0,0,0,.4))' }} />
    </div>
  )
}

// ---------------------------------------------------------------------------

const NONE: McServer[] = []

function ServerView({ srv, hostName, tab, setTab, onDeleted, onSelect }: { srv: McServer; hostName: string; tab: Tab; setTab: (t: Tab) => void; onDeleted: () => void; onSelect: (dir: string) => void }) {
  const host = useStore((s) => s.servers.find((x) => x.id === srv.hostId))!
  const runner = useTaskRunner(srv.hostId)
  const menu = useMenu()
  const [busy, setBusy] = useState('')
  const [dup, setDup] = useState(false)
  const hostServers = useMc((s) => s.servers[srv.hostId] ?? NONE)
  const c = srv.config

  const reload = async () => {
    await refreshDirs(srv.hostId, [srv.dir])
  }

  // poll status
  useEffect(() => {
    const t = setInterval(() => {
      if (!document.hidden) refreshDirs(srv.hostId, [srv.dir]).catch(() => {})
    }, 6000)
    return () => clearInterval(t)
  }, [srv.hostId, srv.dir])

  const saveCfg = async (patch: Partial<McConfig>) => {
    // re-read on-disk config first (the updater may have changed it)
    let base = c
    try {
      base = JSON.parse(await api.fs.readText(srv.hostId, `${srv.dir}/${MC_DIR}/mc.json`))
    } catch { /* not managed yet */ }
    const next = { ...base, ...patch }
    await saveConfig(srv.hostId, srv.dir, next)
    await reload()
  }

  const ctx: McCtx = { srv, host, reload, task: runner.run, saveCfg, setTab: (t) => setTab(t as Tab) }

  const action = async (a: 'start' | 'stop' | 'restart' | 'kill') => {
    if (a === 'kill' && !(await confirm('Force kill the server?', 'The world will NOT be saved. Only use this if the server is frozen.', 'Kill', true))) return
    setBusy(a)
    try {
      if (srv.external) {
        if (a !== 'stop' && a !== 'kill') return
        await run(srv.hostId, `kill ${a === 'kill' ? '-9 ' : ''}${srv.pid}`)
        toast({ title: 'Stop signal sent', body: 'Minecraft saves worlds on SIGTERM before exiting.' })
      } else {
        const r = await ctl(srv.hostId, srv.dir, a)
        const out = (r.stdout + r.stderr).trim()
        if (r.code !== 0 || /Failed|not found|not accepted/i.test(out)) toast({ title: `Couldn't ${a} ${c.name}`, body: out.slice(-400), kind: 'error', action: { label: 'Console', run: () => setTab('Console') } })
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
      await writeManagement(srv.hostId, srv.dir, c)
      toast({ title: 'Management enabled', body: `Helper scripts were added to ${srv.dir}/.sshos`, kind: 'success' })
      await reload()
    } catch (e: any) {
      toast({ title: 'Setup failed', body: e.message, kind: 'error' })
    } finally {
      setBusy('')
    }
  }

  const deleteServer = async () => {
    const typed = await prompt(
      `Delete “${c.name}” permanently?`,
      '',
      `This stops the server and deletes ${srv.dir} including all worlds, plugins and backups stored inside it. Type the server name (${c.name}) to confirm.`,
      'Delete Forever',
      true,
    )
    if (typed === null) return
    if (typed.trim() !== c.name) return toast({ title: 'Name did not match. Nothing was deleted.', kind: 'error' })
    setBusy('delete')
    try {
      if (srv.running && !srv.external && srv.managed) await ctl(srv.hostId, srv.dir, 'stop', '0')
      else if (srv.running && srv.pid) await run(srv.hostId, `kill ${srv.pid}; sleep 10`)
      await removeCron(srv.hostId, c.id)
      await run(srv.hostId, `[ -f ${shq(srv.dir + '/.sshos/web/webctl.sh')} ] && sh ${shq(srv.dir + '/.sshos/web/webctl.sh')} stop; true`)
      const r = await run(srv.hostId, `rm -rf -- ${shq(srv.dir)}`, 300000)
      if (r.code !== 0) throw new Error(r.stderr || 'rm failed')
      removeExtraDir(srv.hostId, srv.dir)
      toast({ title: `Deleted ${c.name}`, kind: 'success' })
      onDeleted()
      await scanHost(srv.hostId)
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
    const level = srv.levelName
    const excludes = [
      'logs', 'cache', 'crash-reports', '.sshos/web', '.sshos/server.pid', '.sshos/mux', '.sshos/stdin', '.sshos/stop-requested', '.sshos/console.log', '.sshos/console.prev.log',
      '.sshos/old-jars', '.sshos/old-content', '.sshos/update.log', '.sshos/backup.log', 'session.lock', '*/session.lock',
      ...(o.includeBackups ? [] : [srv.config.backups.dir && !srv.config.backups.dir.startsWith('/') ? srv.config.backups.dir : 'backups']),
      ...(o.includeWorlds ? [] : [level, `${level}_nether`, `${level}_the_end`]),
    ]
    const r = await runner.run(
      `Duplicating ${c.name}`,
      duplicateScript(srv.dir, o.dir, excludes, live ? `sh ${ctlPath} cmd "save-off" >/dev/null; sh ${ctlPath} cmd "save-all flush" >/dev/null; sleep 6` : '', live ? `sh ${ctlPath} cmd "save-on" >/dev/null` : ''),
    )
    if (r.code !== 0) return
    try {
      // own port, identity, session and schedules for the copy
      const propsPath = `${o.dir}/server.properties`
      const t = await api.fs.readText(srv.hostId, propsPath).catch(() => '')
      await api.fs.writeText(srv.hostId, propsPath, serializeProps(t, { 'server-port': String(o.port), ...(o.includeWorlds ? {} : { 'level-seed': '' }) }))
      if (srv.managed) {
        const old = JSON.parse(await api.fs.readText(srv.hostId, `${o.dir}/${MC_DIR}/mc.json`))
        const fresh = defaultConfig({ name: o.name, software: old.software, mcVersion: old.mcVersion, jar: old.jar })
        await writeManagement(srv.hostId, o.dir, { ...old, id: fresh.id, name: o.name, session: fresh.session, createdAt: Date.now(), web: undefined })
        if (o.startAfter) await ctl(srv.hostId, o.dir, 'start')
      }
      addExtraDir(srv.hostId, o.dir)
      await scanHost(srv.hostId)
      toast({ title: `Created “${o.name}”`, body: `${o.dir} · port ${o.port}`, kind: 'success' })
      onSelect(o.dir)
    } catch (e: any) {
      toast({ title: 'Copy made, but setup failed', body: e.message, kind: 'error' })
    }
  }

  const attach = () => {
    const cmd = `cd ${shq(srv.dir)} && (tmux attach -t ${shq(c.session)} 2>/dev/null || screen -r ${shq(c.session)} 2>/dev/null || tail -f .sshos/console.log)`
    launch('terminal', { serverId: srv.hostId, forceNew: true, props: { command: cmd } })
  }

  return (
    <Ctx.Provider value={ctx}>
      <div className="mc-header">
        <McIcon software={c.software} size={44} />
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="row" style={{ gap: 8 }}>
            <b style={{ fontSize: 17, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</b>
            <StatusPill srv={srv} />
          </div>
          <div className="small muted" style={{ marginTop: 2 }}>
            {SOFTWARE[c.software]?.name} {c.mcVersion}{c.build ? ` · build ${c.build}` : ''} · {hostName}:{srv.port} · <span className="mono">{srv.dir}</span>
          </div>
        </div>
        {srv.managed || srv.external ? (
          <div className="row">
            {!srv.running ? (
              <button className="btn primary lg" disabled={!!busy || !srv.managed} onClick={() => action('start')}>
                {busy === 'start' ? <Spinner size={12} /> : <Play size={13} />} Start
              </button>
            ) : (
              <>
                <button className="btn lg" disabled={!!busy} onClick={() => action('stop')}>
                  {busy === 'stop' ? <Spinner size={12} /> : <Square size={12} />} Stop
                </button>
                {!srv.external && (
                  <button className="btn lg" disabled={!!busy} onClick={() => action('restart')}>
                    {busy === 'restart' ? <Spinner size={12} /> : <RotateCw size={13} />} Restart
                  </button>
                )}
              </>
            )}
          </div>
        ) : null}
        <button
          className="tb-btn"
          onClick={(e) =>
            menu.open(e, [
              { label: 'Open Folder in Finder', icon: <FolderOpen size={14} />, onClick: () => launch('finder', { serverId: srv.hostId, forceNew: true, props: { path: srv.dir } }) },
              { label: 'Terminal in Folder', icon: <TermIcon size={14} />, onClick: () => launch('terminal', { serverId: srv.hostId, forceNew: true, props: { cwd: srv.dir } }) },
              { label: 'Attach to Server Console', disabled: !srv.running || !srv.managed, onClick: attach },
              { separator: true },
              { label: 'Force Kill', danger: true, disabled: !srv.running, onClick: () => action('kill') },
              { label: srv.managed ? 'Reinstall Helper Scripts' : 'Set Up Management', onClick: setup },
              { separator: true },
              { label: 'Duplicate Server…', icon: <Copy size={14} />, onClick: () => setDup(true) },
              { label: 'Delete Server…', danger: true, onClick: deleteServer },
            ])
          }
        >
          <Ellipsis size={18} />
        </button>
      </div>

      {!srv.managed && (
        <div className="mc-banner">
          <Wrench size={18} />
          <div className="grow">
            <b>This server isn’t managed by SSH OS yet.</b>
            <div className="small">
              {srv.external ? 'It is running, started outside SSH OS. ' : ''}Set up management to start/stop it from here, run it in the background, schedule backups and updates, and restart it after crashes. This adds a .sshos folder and changes nothing else.
              {srv.external && ' Stop the server first, then start it from SSH OS.'}
            </div>
          </div>
          <button className="btn primary" disabled={!!busy} onClick={setup}>{busy === 'setup' ? <Spinner size={12} /> : null} Set Up Management</button>
        </div>
      )}

      <div className="mc-tabs">
        {TABS.filter((t) => t !== 'Website' || srv.managed).map((t) => (
          <button key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>{t}</button>
        ))}
      </div>
      <div className="grow" style={{ minHeight: 0, display: 'flex', flexDirection: 'column', position: 'relative' }}>
        {tab === 'Overview' && <Overview />}
        {tab === 'Console' && <ConsoleTab />}
        {tab === 'Players' && <PlayersTab />}
        {tab === 'Content' && <ContentTab />}
        {tab === 'Worlds' && <WorldsTab />}
        {tab === 'Backups' && <BackupsTab />}
        {tab === 'Website' && <WebsiteTab />}
        {tab === 'Updates' && <UpdatesTab />}
        {tab === 'Settings' && <SettingsTab onDelete={deleteServer} />}
        {tab === 'Help' && <HelpTab />}
      </div>
      {runner.el}
      {dup && (
        <DuplicateSheet
          hostId={srv.hostId}
          srcName={c.name}
          srcDir={srv.dir}
          usedPorts={hostServers.map((s) => s.port)}
          defaultPort={srv.port}
          worldsLabel="worlds"
          running={srv.running}
          onCancel={() => setDup(false)}
          onConfirm={duplicate}
        />
      )}
      {menu.el}
    </Ctx.Provider>
  )
}

// ---------------------------------------------------------------------------

interface Live {
  ips: string[]
  rss?: number
  cpu?: number
  etime?: string
  slp?: { players?: { online: number; max: number; sample?: { name: string; id: string }[] }; version?: { name: string }; error?: string }
  disk?: string
}

export function useLive(srv: McServer, withDisk = false) {
  const [live, setLive] = useState<Live | null>(null)
  useEffect(() => {
    let stop = false
    const tick = async () => {
      const script = `hostname -I 2>/dev/null | tr ' ' '\\n' | grep -v ':' | head -3; echo '@@'
${srv.pid ? `ps -o rss=,pcpu=,etime= -p ${srv.pid} 2>/dev/null` : 'true'}; echo '@@'
${srv.running ? SLP_PY(srv.port) : 'echo "{}"'}
echo '@@'
${withDisk ? `timeout 8 du -sh ${shq(srv.dir)} 2>/dev/null | cut -f1` : ''}`
      try {
        const r = await run(srv.hostId, script, 20000)
        const [ips, ps, slp, disk] = r.stdout.split('@@').map((s) => s.trim())
        const [rss, cpu, etime] = ps.split(/\s+/)
        let slpJ: Live['slp']
        try { slpJ = JSON.parse(slp) } catch { slpJ = undefined }
        if (!stop) setLive((l) => ({ ips: ips.split('\n').filter(Boolean), rss: rss ? +rss * 1024 : undefined, cpu: cpu ? +cpu : undefined, etime, slp: slpJ, disk: disk || l?.disk }))
      } catch { /* ignore */ }
      if (!stop) setTimeout(tick, 5000)
    }
    tick()
    return () => { stop = true }
  }, [srv.hostId, srv.dir, srv.running, srv.pid, srv.port, withDisk]) // eslint-disable-line
  return live
}

function fmtMem(b?: number) {
  if (!b) return '—'
  return b > 1024 ** 3 ? (b / 1024 ** 3).toFixed(1) + ' GB' : Math.round(b / 1024 ** 2) + ' MB'
}

function Overview() {
  const { srv, host, setTab, task } = useCtx()
  const live = useLive(srv, true)
  const c = srv.config
  const addr = (h: string) => (srv.port === 25565 ? h : `${h}:${srv.port}`)
  const [say, setSay] = useState('')

  const send = async (cmd: string) => {
    const r = await ctl(srv.hostId, srv.dir, 'cmd', cmd)
    if (r.code !== 0) toast({ title: 'Command failed', body: r.stdout + r.stderr, kind: 'error' })
    else toast({ title: `Sent: /${cmd}`, kind: 'success' })
  }

  const canCmd = srv.running && srv.managed && !srv.external

  return (
    <div className="grow scroll pad">
      <div className="mc-cards">
        <div className="mc-card">
          <div className="mc-card-h"><Users size={14} /> Players</div>
          <div className="mc-big">{srv.running ? `${live?.slp?.players?.online ?? '–'} / ${live?.slp?.players?.max ?? srv.maxPlayers}` : '—'}</div>
          <div className="small muted" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {srv.running ? (live?.slp?.players?.sample?.map((p) => p.name).join(', ') || (live?.slp?.error ? 'Starting up…' : 'Nobody online')) : 'Server is stopped'}
          </div>
        </div>
        <div className="mc-card">
          <div className="mc-card-h"><Cpu size={14} /> Process</div>
          <div className="mc-big">{srv.running ? fmtMem(live?.rss) : '—'}</div>
          <div className="small muted">{srv.running ? `CPU ${live?.cpu ?? '–'}% · up ${live?.etime ?? '–'}` : `Max memory ${c.xmx}`}</div>
        </div>
        <div className="mc-card">
          <div className="mc-card-h"><HardDrive size={14} /> Disk</div>
          <div className="mc-big">{live?.disk ?? '…'}</div>
          <div className="small muted">World “{srv.levelName}”</div>
        </div>
        <div className="mc-card">
          <div className="mc-card-h"><Gauge size={14} /> Version</div>
          <div className="mc-big" style={{ fontSize: 18 }}>{live?.slp?.version?.name ?? `${SOFTWARE[c.software]?.name} ${c.mcVersion}`}</div>
          <div className="small muted">{c.build ? `Build ${c.build}` : 'Build unknown'}</div>
        </div>
      </div>

      <div className="group-box" style={{ marginTop: 14 }}>
        <div className="group-row">
          <div>
            <div className="row" style={{ gap: 4 }}><b>Connect address</b><Help title="Connecting" text="Players add this address in Multiplayer → Add Server. The LAN address works at home; for friends over the internet, forward the port on your router and use your public IP or a domain. See Help → Ports & firewall." /></div>
            <div className="small muted">Use these in Minecraft → Multiplayer → Add Server</div>
          </div>
          <div className="row" style={{ flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            {[...(live?.ips ?? []), host.host].filter((v, i, a) => a.indexOf(v) === i).map((ip) => (
              <button key={ip} className="btn mono" onClick={() => { api.copyText(addr(ip)); toast({ title: 'Copied', body: addr(ip) }) }}>
                {addr(ip)} <Copy size={11} />
              </button>
            ))}
          </div>
        </div>
        <div className="group-row">
          <span>MOTD</span>
          <span className="muted" style={{ maxWidth: 420, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{srv.motd.replace(/§./g, '') || '—'}</span>
        </div>
        <div className="group-row">
          <span>Automation</span>
          <span className="row small" style={{ flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            <span className="badge">{c.autoStart ? 'Starts on boot' : 'No autostart'}</span>
            <span className="badge">{c.restartOnCrash ? 'Restarts on crash' : 'No crash restart'}</span>
            <span className="badge">Updates: {describeSchedule(c.updates.schedule)}</span>
            <span className="badge">Backups: {describeSchedule(c.backups.schedule)}</span>
            <button className="btn" onClick={() => setTab('Settings')}>Edit</button>
          </span>
        </div>
      </div>

      <div className="group-box" style={{ marginTop: 14 }}>
        <div className="group-row">
          <span>Broadcast message</span>
          <div className="row">
            <input className="input" style={{ width: 300 }} placeholder={canCmd ? 'Hello everyone!' : 'Server must be running'} disabled={!canCmd} value={say} onChange={(e) => setSay(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && say) { send('say ' + say); setSay('') } }} />
            <button className="btn" disabled={!canCmd || !say} onClick={() => { send('say ' + say); setSay('') }}><Send size={12} /></button>
          </div>
        </div>
        <div className="group-row">
          <span>Quick actions</span>
          <div className="row" style={{ flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            {[
              ['Save world', 'save-all'], ['Day', 'time set day'], ['Night', 'time set night'], ['Clear weather', 'weather clear'],
              ['Reload whitelist', 'whitelist reload'],
            ].map(([l, cmd]) => (
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

export function ConsoleTab({ hint = 'Type a server command, e.g. op Steve, gamerule keepInventory true — ↑ for history' }: { hint?: string } = {}) {
  const { srv } = useCtx()
  const [lines, setLines] = useState<string[]>([])
  const [cmd, setCmd] = useState('')
  const [filter, setFilter] = useState('')
  const hist = useRef<string[]>([])
  const hIdx = useRef(-1)
  const scroller = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const partial = useRef('')

  const logFile = srv.managed && !srv.external ? `${srv.dir}/.sshos/console.log` : `${srv.dir}/logs/latest.log`

  useEffect(() => {
    const sid = Math.random().toString(36).slice(2)
    setLines([])
    partial.current = ''
    const off = api.on('stream:event', (e: { id: string; type: string; data?: string }) => {
      if (e.id !== sid || e.type !== 'data') return
      // eslint-disable-next-line no-control-regex
      const text = partial.current + (e.data ?? '').replace(/\r/g, '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
      const parts = text.split('\n')
      partial.current = parts.pop() ?? ''
      if (parts.length) setLines((l) => [...l, ...parts.filter((p) => !/^tail: /.test(p))].slice(-4000))
    })
    api.stream.start(srv.hostId, sid, `tail -n 500 -F ${shq(logFile)} 2>&1`)
    return () => {
      off()
      api.stream.stop(sid)
    }
  }, [srv.hostId, logFile])

  useEffect(() => {
    if (stick.current && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight
  }, [lines])

  const send = async () => {
    const c = cmd.trim().replace(/^\//, '')
    if (!c) return
    hist.current = [c, ...hist.current.filter((x) => x !== c)].slice(0, 50)
    hIdx.current = -1
    setCmd('')
    const r = await ctl(srv.hostId, srv.dir, 'cmd', c)
    if (r.code !== 0) toast({ title: 'Command not sent', body: (r.stdout + r.stderr).trim(), kind: 'error' })
  }

  const shown = useMemo(() => (filter ? lines.filter((l) => l.toLowerCase().includes(filter.toLowerCase())) : lines), [lines, filter])
  const canCmd = srv.running && srv.managed && !srv.external

  return (
    <>
      <div className="row" style={{ padding: '6px 12px', borderBottom: '1px solid var(--border)' }}>
        <span className="small muted mono grow" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{logFile}</span>
        <div className="search" style={{ width: 200 }}>
          <input placeholder="Filter" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>
        <button className="btn" onClick={() => setLines([])}>Clear</button>
      </div>
      <div
        ref={scroller}
        className="grow scroll mc-console"
        onScroll={(e) => {
          const el = e.currentTarget
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
        }}
      >
        {shown.length === 0 && <div className="muted" style={{ padding: 12 }}>{srv.running ? 'Waiting for output…' : 'The server is stopped. Its output will appear here when it starts.'}</div>}
        {shown.map((l, i) => (
          <div key={i} className={`mc-line ${/ERROR|SEVERE|Exception|\[SSH OS\].*(crash|unexpected|giving up)/i.test(l) ? 'err' : /WARN/.test(l) ? 'warn' : /\[SSH OS\]/.test(l) ? 'sys' : /joined the game|left the game/.test(l) ? 'join' : ''}`}>{l}</div>
        ))}
      </div>
      <div className="row" style={{ padding: 8, borderTop: '1px solid var(--border)' }}>
        <span className="mono muted">/</span>
        <input
          className="input mono grow"
          placeholder={canCmd ? hint : srv.external ? 'Started outside SSH OS — commands unavailable' : 'Start the server to send commands'}
          disabled={!canCmd}
          value={cmd}
          onChange={(e) => setCmd(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') send()
            else if (e.key === 'ArrowUp') {
              e.preventDefault()
              hIdx.current = Math.min(hist.current.length - 1, hIdx.current + 1)
              if (hist.current[hIdx.current]) setCmd(hist.current[hIdx.current])
            } else if (e.key === 'ArrowDown') {
              e.preventDefault()
              hIdx.current = Math.max(-1, hIdx.current - 1)
              setCmd(hIdx.current < 0 ? '' : hist.current[hIdx.current])
            }
          }}
        />
        <button className="btn primary" disabled={!canCmd || !cmd.trim()} onClick={send}>Send</button>
      </div>
    </>
  )
}
