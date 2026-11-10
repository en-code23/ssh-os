import { useEffect, useMemo, useRef, useState } from 'react'
import { Info, Search, XOctagon, RotateCw, Play, Square, TerminalSquare } from 'lucide-react'
import { api, shq } from '../lib/api'
import { confirm, toast, useStore, Win } from '../lib/store'
import { Toolbar } from '../components/Window'
import { Segmented, Spinner, useMenu } from '../components/ui'
import { formatBytes } from '../lib/files'
import { launch } from './launch'

type Tab = 'cpu' | 'memory' | 'disk' | 'network' | 'services'

interface Proc { pid: number; user: string; cpu: number; mem: number; rss: number; time: string; name: string; cmd: string }
interface Sample {
  cpu: number
  memUsed: number
  memTotal: number
  swapUsed: number
  swapTotal: number
  load: string
  uptime: number
  rx: number
  tx: number
  disks: { fs: string; size: number; used: number; avail: number; mount: string }[]
  procs: Proc[]
}

const SCRIPT = `
head -1 /proc/stat; echo '@@'
grep -E '^(MemTotal|MemAvailable|SwapTotal|SwapFree):' /proc/meminfo; echo '@@'
df -Pk -x tmpfs -x devtmpfs -x squashfs -x overlay 2>/dev/null | tail -n +2; echo '@@'
cat /proc/loadavg; echo '@@'
cat /proc/uptime; echo '@@'
tail -n +3 /proc/net/dev; echo '@@'
ps -eo pid=,user:16=,pcpu=,pmem=,rss=,etime=,comm=,args= --sort=-pcpu 2>/dev/null | head -300
`

function parse(out: string, prev: React.MutableRefObject<{ idle: number; total: number; rx: number; tx: number; t: number } | null>): Sample {
  const [stat, mem, df, load, up, net, ps] = out.split('@@\n')
  const nums = stat.trim().split(/\s+/).slice(1).map(Number)
  const idle = nums[3] + (nums[4] || 0)
  const total = nums.reduce((a, b) => a + b, 0)
  const m: Record<string, number> = {}
  for (const l of mem.trim().split('\n')) {
    const [k, v] = l.split(':')
    m[k] = parseInt(v) * 1024
  }
  let rx = 0
  let tx = 0
  for (const l of net.trim().split('\n')) {
    const [iface, rest] = l.split(':')
    if (!rest || iface.trim() === 'lo') continue
    const f = rest.trim().split(/\s+/).map(Number)
    rx += f[0]
    tx += f[8]
  }
  const now = Date.now()
  let cpu = 0
  let rxRate = 0
  let txRate = 0
  if (prev.current) {
    const dt = total - prev.current.total
    cpu = dt > 0 ? (1 - (idle - prev.current.idle) / dt) * 100 : 0
    const sec = (now - prev.current.t) / 1000
    rxRate = Math.max(0, (rx - prev.current.rx) / sec)
    txRate = Math.max(0, (tx - prev.current.tx) / sec)
  }
  prev.current = { idle, total, rx, tx, t: now }
  const procs: Proc[] = (ps ?? '')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const p = l.trim().split(/\s+/)
      const cmd = p.slice(7).join(' ')
      // comm is truncated to 15 chars; prefer the executable's basename when it extends comm
      const exe = (p[7] ?? '').split('/').pop() ?? ''
      const name = exe.startsWith(p[6]) && exe.length > p[6].length ? exe : p[6]
      return { pid: +p[0], user: p[1], cpu: +p[2], mem: +p[3], rss: +p[4] * 1024, time: p[5], name, cmd }
    })
    .filter((p) => !Number.isNaN(p.pid))
  const disks = df
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const p = l.split(/\s+/)
      return { fs: p[0], size: +p[1] * 1024, used: +p[2] * 1024, avail: +p[3] * 1024, mount: p.slice(5).join(' ') }
    })
  return {
    cpu: Math.max(0, Math.min(100, cpu)),
    memTotal: m.MemTotal || 0,
    memUsed: (m.MemTotal || 0) - (m.MemAvailable || 0),
    swapTotal: m.SwapTotal || 0,
    swapUsed: (m.SwapTotal || 0) - (m.SwapFree || 0),
    load: load.trim().split(' ').slice(0, 3).join('  '),
    uptime: parseFloat(up),
    rx: rxRate,
    tx: txRate,
    disks,
    procs,
  }
}

function Spark({ data, color, max = 100, h = 60, data2, color2 }: { data: number[]; color: string; max?: number; h?: number; data2?: number[]; color2?: string }) {
  const W = 300
  const N = 60
  const m = Math.max(max, ...data, ...(data2 ?? []), 1)
  const pts = (d: number[]) => {
    const arr = d.slice(-N)
    return arr.map((v, i) => `${((N - arr.length + i) / (N - 1)) * W},${h - (v / m) * (h - 2)}`).join(' ')
  }
  const area = (d: number[]) => {
    const arr = d.slice(-N)
    if (!arr.length) return ''
    const start = ((N - arr.length) / (N - 1)) * W
    return `M${start},${h} L${pts(d).split(' ').join(' L')} L${W},${h} Z`
  }
  return (
    <svg viewBox={`0 0 ${W} ${h}`} preserveAspectRatio="none" style={{ width: '100%', height: h, display: 'block' }}>
      {[0.25, 0.5, 0.75].map((f) => <line key={f} x1="0" x2={W} y1={h * f} y2={h * f} stroke="var(--border)" strokeWidth="1" />)}
      <path d={area(data)} fill={color} fillOpacity="0.25" />
      <polyline points={pts(data)} fill="none" stroke={color} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
      {data2 && (
        <>
          <path d={area(data2)} fill={color2} fillOpacity="0.2" />
          <polyline points={pts(data2)} fill="none" stroke={color2} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
        </>
      )}
    </svg>
  )
}

function fmtUptime(s: number) {
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  return `${d ? d + 'd ' : ''}${h}h ${m}m`
}

export function ActivityMonitor({ win }: { win: Win }) {
  const serverId = win.serverId!
  const server = useStore((s) => s.servers.find((x) => x.id === serverId))
  const connected = useStore((s) => s.conns[serverId]?.status === 'connected')
  const [tab, setTab] = useState<Tab>('cpu')
  const [sample, setSample] = useState<Sample | null>(null)
  const [hist, setHist] = useState<{ cpu: number[]; mem: number[]; rx: number[]; tx: number[] }>({ cpu: [], mem: [], rx: [], tx: [] })
  const [sel, setSel] = useState<number | null>(null)
  const [q, setQ] = useState('')
  const [sort, setSort] = useState<{ k: keyof Proc; asc: boolean }>({ k: 'cpu', asc: false })
  const [sysInfo, setSysInfo] = useState('')
  const [error, setError] = useState('')
  const prev = useRef<any>(null)
  const menu = useMenu()

  useEffect(() => {
    if (!connected) return
    api.exec(serverId, `(. /etc/os-release 2>/dev/null; echo "$PRETTY_NAME") ; uname -srm; nproc; hostname`).then((r) => setSysInfo(r.stdout.trim()))
    let stop = false
    const tick = async () => {
      try {
        const r = await api.exec(serverId, SCRIPT, 15000)
        if (stop) return
        const s = parse(r.stdout, prev)
        setSample(s)
        setError('')
        setHist((h) => ({
          cpu: [...h.cpu, s.cpu].slice(-60),
          mem: [...h.mem, s.memTotal ? (s.memUsed / s.memTotal) * 100 : 0].slice(-60),
          rx: [...h.rx, s.rx].slice(-60),
          tx: [...h.tx, s.tx].slice(-60),
        }))
      } catch (e: any) {
        setError(e.message)
      }
      if (!stop) setTimeout(tick, 2000)
    }
    tick()
    return () => {
      stop = true
    }
  }, [serverId, connected])

  const procs = useMemo(() => {
    if (!sample) return []
    let l = sample.procs
    if (q) l = l.filter((p) => `${p.name} ${p.cmd} ${p.pid} ${p.user}`.toLowerCase().includes(q.toLowerCase()))
    const k = tab === 'memory' && sort.k === 'cpu' ? 'rss' : sort.k
    return [...l].sort((a, b) => {
      const va = a[k]
      const vb = b[k]
      const r = typeof va === 'number' ? (va as number) - (vb as number) : String(va).localeCompare(String(vb))
      return sort.asc ? r : -r
    })
  }, [sample, q, sort, tab])

  const kill = async (pid: number, force = false) => {
    const p = sample?.procs.find((x) => x.pid === pid)
    if (!(await confirm(`Are you sure you want to ${force ? 'force quit' : 'quit'} “${p?.name ?? pid}”?`, force ? 'The process will be killed immediately (SIGKILL).' : 'The process will be asked to terminate (SIGTERM).', force ? 'Force Quit' : 'Quit', true))) return
    const r = await api.exec(serverId, `kill -${force ? 'KILL' : 'TERM'} ${pid}`)
    if (r.code !== 0) {
      toast({ title: `Couldn't stop process ${pid}`, body: (r.stderr.trim() || 'Permission denied') + ' — try with sudo in Terminal.', kind: 'error', action: { label: 'Terminal', run: () => launch('terminal', { serverId, forceNew: true, props: { command: `sudo kill -${force ? 'KILL' : 'TERM'} ${pid}` } }) } })
    }
  }

  const header = (k: keyof Proc, label: string, num = false) => (
    <th className={num ? 'num' : ''} onClick={() => setSort((s) => ({ k, asc: s.k === k ? !s.asc : !num }))} style={{ cursor: 'default', fontWeight: sort.k === k ? 600 : 500 }}>
      {label} {sort.k === k ? (sort.asc ? '▲' : '▼') : ''}
    </th>
  )

  const [osName, kernel, cores, host] = sysInfo.split('\n')

  return (
    <>
      <Toolbar>
        <div style={{ width: 84 }} />
        <div style={{ minWidth: 0 }}>
          <div className="toolbar-title" style={{ fontSize: 13 }}>Activity Monitor</div>
          <div className="small muted" style={{ whiteSpace: 'nowrap' }}>{server?.name} · {host}</div>
        </div>
        <button className="tb-btn" title="Quit Process" disabled={sel === null || tab === 'services'} onClick={(e) => sel !== null && menu.open(e, [
          { label: 'Quit (SIGTERM)', onClick: () => kill(sel) },
          { label: 'Force Quit (SIGKILL)', danger: true, onClick: () => kill(sel, true) },
        ])}>
          <XOctagon size={17} />
        </button>
        <button className="tb-btn" title="Process Info" disabled={sel === null || tab === 'services'} onClick={() => {
          const p = sample?.procs.find((x) => x.pid === sel)
          if (p) toast({ title: `${p.name} (${p.pid})`, body: `${p.cmd}\nUser: ${p.user} · CPU ${p.cpu}% · ${formatBytes(p.rss)} · ${p.time}` })
        }}>
          <Info size={17} />
        </button>
        <div style={{ flex: 1, display: 'flex', justifyContent: 'center' }}>
          <Segmented
            value={tab}
            onChange={setTab}
            options={[
              { value: 'cpu', label: 'CPU' },
              { value: 'memory', label: 'Memory' },
              { value: 'disk', label: 'Disk' },
              { value: 'network', label: 'Network' },
              { value: 'services', label: 'Services' },
            ]}
          />
        </div>
        <div className="search">
          <Search size={13} />
          <input placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </Toolbar>
      {tab === 'services' ? (
        <Services serverId={serverId} q={q} />
      ) : (
        <>
          <div className="grow scroll">
            {!sample ? (
              <div className="empty">{error ? error : <Spinner size={22} />}</div>
            ) : tab === 'disk' ? (
              <table className="table">
                <thead>
                  <tr><th>Mount</th><th>Device</th><th className="num">Size</th><th className="num">Used</th><th className="num">Available</th><th style={{ width: 200 }}>Usage</th></tr>
                </thead>
                <tbody>
                  {sample.disks.map((d) => {
                    const pct = d.size ? (d.used / d.size) * 100 : 0
                    return (
                      <tr key={d.mount + d.fs}>
                        <td>{d.mount}</td>
                        <td className="mono muted">{d.fs}</td>
                        <td className="num">{formatBytes(d.size)}</td>
                        <td className="num">{formatBytes(d.used)}</td>
                        <td className="num">{formatBytes(d.avail)}</td>
                        <td>
                          <div className="progress" style={{ height: 6 }}>
                            <div style={{ width: `${pct}%`, background: pct > 90 ? 'var(--red)' : pct > 75 ? 'var(--orange)' : 'var(--accent)' }} />
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    {header('name', 'Process Name')}
                    {tab === 'memory' ? header('rss', 'Memory', true) : header('cpu', '% CPU', true)}
                    {tab === 'memory' ? header('mem', '% Mem', true) : header('mem', '% Mem', true)}
                    {header('time', 'Time')}
                    {header('pid', 'PID', true)}
                    {header('user', 'User')}
                  </tr>
                </thead>
                <tbody>
                  {procs.map((p) => (
                    <tr
                      key={p.pid}
                      className={sel === p.pid ? 'sel' : ''}
                      onMouseDown={() => setSel(p.pid)}
                      title={p.cmd}
                      onContextMenu={(e) => {
                        setSel(p.pid)
                        menu.open(e, [
                          { label: 'Quit Process', onClick: () => kill(p.pid) },
                          { label: 'Force Quit Process', danger: true, onClick: () => kill(p.pid, true) },
                          { separator: true },
                          { label: 'Copy PID', onClick: () => api.copyText(String(p.pid)) },
                          { label: 'Copy Command', onClick: () => api.copyText(p.cmd) },
                        ])
                      }}
                    >
                      <td style={{ maxWidth: 260 }}>{p.name}</td>
                      <td className="num">{tab === 'memory' ? formatBytes(p.rss) : p.cpu.toFixed(1)}</td>
                      <td className="num">{p.mem.toFixed(1)}</td>
                      <td className="mono">{p.time}</td>
                      <td className="num">{p.pid}</td>
                      <td>{p.user}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          {sample && (
            <div style={{ borderTop: '1px solid var(--border)', padding: 12, display: 'grid', gridTemplateColumns: '1fr 1.2fr 1fr', gap: 18, alignItems: 'center', background: 'var(--win-bg-2)', flexShrink: 0 }}>
              <div className="small" style={{ lineHeight: 1.7 }}>
                {tab === 'cpu' || tab === 'disk' ? (
                  <>
                    <Stat label="CPU Usage" value={`${sample.cpu.toFixed(1)}%`} color="var(--red)" />
                    <Stat label="Load Average" value={sample.load} />
                    <Stat label="Cores" value={cores ?? '-'} />
                    <Stat label="Processes" value={String(sample.procs.length)} />
                  </>
                ) : tab === 'memory' ? (
                  <>
                    <Stat label="Physical Memory" value={formatBytes(sample.memTotal)} />
                    <Stat label="Memory Used" value={formatBytes(sample.memUsed)} color="var(--accent)" />
                    <Stat label="Swap Used" value={`${formatBytes(sample.swapUsed, true)} / ${formatBytes(sample.swapTotal, true)}`} />
                  </>
                ) : (
                  <>
                    <Stat label="Data received/sec" value={formatBytes(Math.round(sample.rx), true)} color="var(--purple)" />
                    <Stat label="Data sent/sec" value={formatBytes(Math.round(sample.tx), true)} color="var(--red)" />
                  </>
                )}
              </div>
              <div className="card" style={{ padding: 6 }}>
                <div className="small muted" style={{ textAlign: 'center', marginBottom: 2 }}>
                  {tab === 'memory' ? 'MEMORY PRESSURE' : tab === 'network' ? 'PACKETS' : 'CPU LOAD'}
                </div>
                {tab === 'memory' ? (
                  <Spark data={hist.mem} color="var(--green)" />
                ) : tab === 'network' ? (
                  <Spark data={hist.rx} data2={hist.tx} color="var(--purple)" color2="var(--red)" max={1024} />
                ) : (
                  <Spark data={hist.cpu} color="var(--red)" />
                )}
              </div>
              <div className="small" style={{ lineHeight: 1.7 }}>
                <Stat label="System" value={osName ?? '-'} />
                <Stat label="Kernel" value={kernel ?? '-'} />
                <Stat label="Uptime" value={fmtUptime(sample.uptime)} />
              </div>
            </div>
          )}
        </>
      )}
      {menu.el}
    </>
  )
}

function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="row" style={{ justifyContent: 'space-between', gap: 10 }}>
      <span className="muted">{label}:</span>
      <span style={{ color, fontWeight: color ? 600 : 400, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{value}</span>
    </div>
  )
}

interface Svc { unit: string; load: string; active: string; sub: string; desc: string }

function Services({ serverId, q }: { serverId: string; q: string }) {
  const [list, setList] = useState<Svc[] | null>(null)
  const [err, setErr] = useState('')
  const [sel, setSel] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = async () => {
    const r = await api.exec(serverId, 'systemctl list-units --type=service --all --no-pager --no-legend --plain 2>&1')
    if (r.code !== 0 && !r.stdout.includes('.service')) {
      setErr(r.stdout.trim() || r.stderr.trim() || 'systemd is not available on this server')
      setList([])
      return
    }
    setList(
      r.stdout
        .trim()
        .split('\n')
        .filter((l) => l.includes('.service'))
        .map((l) => {
          const p = l.trim().replace(/^●\s*/, '').split(/\s+/)
          return { unit: p[0], load: p[1], active: p[2], sub: p[3], desc: p.slice(4).join(' ') }
        }),
    )
  }
  useEffect(() => {
    load()
  }, [serverId]) // eslint-disable-line

  const act = async (verb: 'start' | 'stop' | 'restart') => {
    if (!sel) return
    setBusy(true)
    const r = await api.exec(serverId, `sudo -n systemctl ${verb} ${shq(sel)} 2>&1 || systemctl ${verb} ${shq(sel)} 2>&1`)
    setBusy(false)
    if (r.code !== 0) {
      toast({
        title: `Couldn't ${verb} ${sel}`,
        body: 'This needs administrator rights. Run it in Terminal with sudo.',
        kind: 'error',
        action: { label: 'Terminal', run: () => launch('terminal', { serverId, forceNew: true, props: { command: `sudo systemctl ${verb} ${shq(sel)}` } }) },
      })
    } else toast({ title: `${sel}: ${verb} OK`, kind: 'success' })
    load()
  }

  const shown = (list ?? []).filter((s) => !q || `${s.unit} ${s.desc}`.toLowerCase().includes(q.toLowerCase()))

  return (
    <>
      <div className="row" style={{ padding: '6px 10px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
        <button className="btn" disabled={!sel || busy} onClick={() => act('start')}><Play size={12} /> Start</button>
        <button className="btn" disabled={!sel || busy} onClick={() => act('stop')}><Square size={12} /> Stop</button>
        <button className="btn" disabled={!sel || busy} onClick={() => act('restart')}><RotateCw size={12} /> Restart</button>
        <button className="btn" disabled={!sel} onClick={() => sel && launch('console', { serverId, forceNew: true, props: { source: `journalctl -u ${sel} -n 300 --no-pager`, follow: true } })}>
          <TerminalSquare size={12} /> Logs
        </button>
        <div className="grow" />
        <button className="btn" onClick={load}><RotateCw size={12} /></button>
      </div>
      <div className="grow scroll">
        {list === null ? (
          <div className="empty"><Spinner size={22} /></div>
        ) : err ? (
          <div className="empty">{err}</div>
        ) : (
          <table className="table">
            <thead>
              <tr><th>Service</th><th>State</th><th>Sub</th><th>Description</th></tr>
            </thead>
            <tbody>
              {shown.map((s) => (
                <tr key={s.unit} className={sel === s.unit ? 'sel' : ''} onMouseDown={() => setSel(s.unit)}>
                  <td>{s.unit.replace(/\.service$/, '')}</td>
                  <td>
                    <span className="row" style={{ gap: 6 }}>
                      <span className={`status-dot ${s.active === 'active' ? 'connected' : s.active === 'failed' ? 'error' : 'disconnected'}`} />
                      {s.active}
                    </span>
                  </td>
                  <td>{s.sub}</td>
                  <td className="muted" style={{ maxWidth: 400 }}>{s.desc}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  )
}
