import { useEffect, useMemo, useState } from 'react'
import { Check, ChevronLeft, ChevronRight, Info, Rocket } from 'lucide-react'
import { api, shq } from '../../lib/api'
import { toast, useStore } from '../../lib/store'
import { useTr, scanTrHost, addTrDir } from '../../lib/tr/store'
import { defaultTrConfig, serializeServerConfig, TR_SOFTWARE, TrSoftware, WORLD_DIR, writeTrManagement } from '../../lib/tr/server'
import { installScript, latestRelease, supportOn, type TrRelease } from '../../lib/tr/apis'
import { TR_PRESETS, tuneTr } from '../../lib/tr/config'
import { ctl, Schedule } from '../../lib/mc/server'
import { Spinner, Switch } from '../../components/ui'
import { Row, ScheduleEditor, Section, useTaskRunner } from '../minecraft/common'
import { TrIcon } from './Terraria'

const STEPS = ['Basics', 'Software', 'Players', 'World', 'Automation'] as const
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'server'

export function NewTerrariaServer({ hostId: initialHost, onCancel, onCreated }: { hostId?: string; onCancel: () => void; onCreated: (hostId: string, dir: string) => void }) {
  const servers = useStore((s) => s.servers)
  const conns = useStore((s) => s.conns)
  const tr = useTr((s) => s.servers)
  const hosts = servers.filter((s) => s.protocol === 'ssh' && conns[s.id]?.status === 'connected')
  const [hostId, setHostId] = useState(initialHost && hosts.some((h) => h.id === initialHost) ? initialHost : hosts[0]?.id)
  const runner = useTaskRunner(hostId ?? '')
  const home = hostId ? conns[hostId]?.home ?? '~' : '~'

  const [step, setStep] = useState(0)
  const [name, setName] = useState('My World')
  const [dir, setDir] = useState('')
  const [dirTouched, setDirTouched] = useState(false)
  const [sys, setSys] = useState<{ arch: string; memMb: number; cpus: number; tools: string } | null>(null)
  const [software, setSoftware] = useState<TrSoftware>('tshock')
  const [release, setRelease] = useState<TrRelease | null | 'error'>(null)
  const [players, setPlayers] = useState(8)
  const [worldName, setWorldName] = useState('My World')
  const [size, setSize] = useState('2')
  const [difficulty, setDifficulty] = useState('0')
  const [seed, setSeed] = useState('')
  const [password, setPassword] = useState('')
  const [motd, setMotd] = useState('')
  const [port, setPort] = useState(7777)
  const [autoStart, setAutoStart] = useState(true)
  const [crash, setCrash] = useState(true)
  const [bak, setBak] = useState<Schedule>({ kind: 'daily', time: '04:00' })
  const [startNow, setStartNow] = useState(true)

  useEffect(() => {
    if (!hostId) return
    setSys(null)
    api.exec(hostId, `uname -m; grep MemTotal /proc/meminfo | awk '{print $2}'; nproc 2>/dev/null || echo 1; (command -v unzip || command -v python3 || command -v bsdtar) >/dev/null && echo unzip-ok`).then((r) => {
      const [arch, mem, cpus, tools] = r.stdout.trim().split('\n')
      setSys({ arch, memMb: Math.floor((parseInt(mem) || 0) / 1024), cpus: parseInt(cpus) || 1, tools: tools ?? '' })
    })
    const used = (tr[hostId] ?? []).map((s) => s.port)
    let p = 7777
    while (used.includes(p)) p++
    setPort(p)
  }, [hostId]) // eslint-disable-line

  useEffect(() => { if (!dirTouched) setDir(`${home}/terraria/${slug(name)}`) }, [name, home, dirTouched])
  useEffect(() => { setWorldName(name) }, [name])

  useEffect(() => {
    if (!sys) return
    setRelease(null)
    if (!supportOn(software, sys.arch).ok) return setRelease('error')
    latestRelease(software, sys.arch).then(setRelease).catch(() => setRelease('error'))
  }, [software, sys])

  const tuning = useMemo(() => (sys ? tuneTr(players, software, sys.memMb, sys.cpus) : null), [players, software, sys])
  useEffect(() => { if (tuning) setSize(tuning.worldSize) }, [tuning])

  const support = sys ? supportOn(software, sys.arch) : { ok: true }
  const exists = !!hostId && (tr[hostId] ?? []).some((s) => s.dir === dir)
  const valid = [!!hostId && !!name.trim() && dir.startsWith('/') && !exists, support.ok && !!release && release !== 'error', players >= 1 && players <= 255, !!worldName.trim(), true]

  const create = async () => {
    if (!hostId || !release || release === 'error') return
    try {
      const pre = `D=${shq(dir)}; if [ -d "$D" ] && [ -n "$(ls -A "$D" 2>/dev/null)" ]; then echo "Folder $D already exists and is not empty"; exit 3; fi`
      const r = await runner.run(`Creating ${name}`, `${pre}\n${installScript(software, release, dir)}`)
      if (r.code !== 0) return
      const worldFile = (worldName.replace(/[^\w -]+/g, '').replace(/\s+/g, '_') || 'World') + '.wld'
      const sc = serializeServerConfig(`# Terraria server config, created by SSH OS ${new Date().toISOString()}\n`, {
        world: `${dir}/${WORLD_DIR}/${worldFile}`,
        autocreate: size,
        worldname: worldName.trim(),
        difficulty,
        seed: seed.trim(),
        worldpath: `${dir}/${WORLD_DIR}`,
        maxplayers: String(players),
        port: String(port),
        password,
        motd: motd.trim(),
        secure: '1',
        upnp: '0',
        npcstream: String(tuning?.npcstream ?? 60),
        language: 'en-US',
      })
      await api.fs.writeText(hostId, `${dir}/serverconfig.txt`, sc)
      const cfg = defaultTrConfig({
        name: name.trim(), software, version: release.version, terraria: release.terraria,
        autoStart, restartOnCrash: crash, backups: { schedule: bak, keep: 7, scope: 'worlds', dir: 'backups' },
      })
      await writeTrManagement(hostId, dir, cfg)
      addTrDir(hostId, dir)
      if (startNow) {
        const s = await ctl(hostId, dir, 'start')
        if (s.code !== 0) toast({ title: 'Server created, but it did not start', body: (s.stdout + s.stderr).slice(-300), kind: 'error' })
      }
      await scanTrHost(hostId)
      toast({ title: `${name} is ready`, body: startNow ? 'The first start generates the world; this takes a minute or two.' : 'Press Start when you are ready.', kind: 'success' })
      onCreated(hostId, dir)
    } catch (e: any) {
      toast({ title: 'Could not create the server', body: e.message, kind: 'error' })
    }
  }

  if (!hosts.length) return <div className="empty"><h3>Connect to an SSH server first</h3><button className="btn" onClick={onCancel}>Back</button></div>

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div className="wizard-steps">
        {STEPS.map((s, i) => (
          <button key={s} className={`${i === step ? 'on' : ''} ${i < step ? 'done' : ''}`} onClick={() => (i <= step || valid.slice(0, i).every(Boolean) ? setStep(i) : null)}>
            <span className="num">{i < step ? <Check size={11} /> : i + 1}</span> {s}
          </button>
        ))}
      </div>
      <div className="grow scroll pad" style={{ maxWidth: 760, width: '100%', margin: '0 auto' }}>
        {step === 0 && (
          <>
            <h2 className="wiz-h">Create a Terraria server</h2>
            <p className="muted wiz-p">SSH OS downloads the server, creates the world and keeps it running in the background.</p>
            <Section title="Basics">
              <Row label="Machine"><select className="select" style={{ width: 240 }} value={hostId} onChange={(e) => setHostId(e.target.value)}>{hosts.map((h) => <option key={h.id} value={h.id}>{h.name} ({h.host})</option>)}</select></Row>
              <Row label="Server name"><input className="input" style={{ width: 240 }} value={name} onChange={(e) => setName(e.target.value)} /></Row>
              <Row label="Folder" sub={exists ? <span style={{ color: 'var(--red)' }}>A server already exists here</span> : undefined}><input className="input mono" style={{ width: 340 }} value={dir} onChange={(e) => { setDir(e.target.value); setDirTouched(true) }} /></Row>
            </Section>
            {sys && <div className="card small">{(sys.memMb / 1024).toFixed(1)} GB RAM · {sys.cpus} CPU cores · {sys.arch}{!sys.tools && <div style={{ color: 'var(--orange)' }}>No unzip tool found: install unzip (sudo apt install unzip).</div>}</div>}
          </>
        )}

        {step === 1 && (
          <>
            <h2 className="wiz-h">Server software</h2>
            <p className="muted wiz-p">TShock is recommended for almost everyone.</p>
            <div className="sw-grid">
              {(['tshock', 'tmodloader', 'vanilla'] as TrSoftware[]).map((s) => {
                const sup = sys ? supportOn(s, sys.arch) : { ok: true }
                return (
                  <button key={s} className={`sw-card ${software === s ? 'on' : ''}`} disabled={!sup.ok} style={{ opacity: sup.ok ? 1 : 0.5 }} onClick={() => setSoftware(s)}>
                    <TrIcon software={s} size={34} />
                    <div style={{ textAlign: 'left' }}>
                      <div className="row" style={{ gap: 6 }}><b>{TR_SOFTWARE[s].name}</b>{s === 'tshock' && <span className="badge" style={{ color: 'var(--accent)' }}>Recommended</span>}</div>
                      <div className="small muted">{TR_SOFTWARE[s].blurb}</div>
                      {!sup.ok && <div className="small" style={{ color: 'var(--red)' }}>{sup.note}</div>}
                    </div>
                  </button>
                )
              })}
            </div>
            <div className="card small" style={{ margin: '12px 0', lineHeight: 1.5 }}><Info size={12} /> {TR_SOFTWARE[software].help}</div>
            {support.note && support.ok && <div className="card small" style={{ color: 'var(--orange)', marginBottom: 12 }}>{support.note}</div>}
            <Section title="Version">
              <Row label="Newest release" sub="SSH OS always installs the newest version.">
                {release === null ? <Spinner size={14} /> : release === 'error' ? <span className="small" style={{ color: 'var(--red)' }}>{support.ok ? 'Could not load releases' : 'Not available on this machine'}</span> : (
                  <b>{TR_SOFTWARE[software].name} {release.version}{release.terraria && software !== 'vanilla' ? ` (Terraria ${release.terraria})` : ''}</b>
                )}
              </Row>
            </Section>
          </>
        )}

        {step === 2 && (
          <>
            <h2 className="wiz-h">How many players?</h2>
            <p className="muted wiz-p">Sets the player limit and picks a world size and network settings that fit.</p>
            <div className="sw-grid">
              {TR_PRESETS.map((p) => (
                <button key={p.players} className={`sw-card ${players === p.players ? 'on' : ''}`} onClick={() => setPlayers(p.players)}>
                  <div style={{ fontSize: 22, fontWeight: 700, minWidth: 70, textAlign: 'center' }}>{p.label}</div>
                  <div style={{ textAlign: 'left' }}><b>{p.label} players</b><div className="small muted">{p.hint}</div></div>
                </button>
              ))}
            </div>
            <Section title="Exact number">
              <Row label="Maximum players" help="maxplayers in serverconfig.txt (1–255)."><input className="input" type="number" min={1} max={255} style={{ width: 90 }} value={players} onChange={(e) => setPlayers(Math.max(1, Math.min(255, +e.target.value || 1)))} /></Row>
            </Section>
            {tuning && (
              <div className="card" style={{ lineHeight: 1.6 }}>
                <b>Recommended for {players} players</b>
                {tuning.notes.map((n, i) => <div key={i} className="small muted">{n}</div>)}
                {tuning.warnings.map((w, i) => <div key={i} className="small" style={{ color: 'var(--orange)' }}>⚠ {w}</div>)}
              </div>
            )}
          </>
        )}

        {step === 3 && (
          <>
            <h2 className="wiz-h">World</h2>
            <Section title="New world" help="Generated on the first start (takes a minute or two).">
              <Row label="World name"><input className="input" style={{ width: 240 }} value={worldName} onChange={(e) => setWorldName(e.target.value)} /></Row>
              <Row label="Size" help="Recommended from the player count; Large worlds use more memory.">
                <select className="select" style={{ width: 160 }} value={size} onChange={(e) => setSize(e.target.value)}><option value="1">Small</option><option value="2">Medium</option><option value="3">Large</option></select>
              </Row>
              <Row label="Difficulty">
                <select className="select" style={{ width: 160 }} value={difficulty} onChange={(e) => setDifficulty(e.target.value)}><option value="0">Classic</option><option value="1">Expert</option><option value="2">Master</option><option value="3">Journey</option></select>
              </Row>
              <Row label="Seed" help="Empty = random. Secret seeds work too."><input className="input" style={{ width: 240 }} value={seed} onChange={(e) => setSeed(e.target.value)} /></Row>
            </Section>
            <Section title="Access">
              <Row label="Password" help="Players must enter it to join. Empty = open server."><input className="input" type="password" style={{ width: 200 }} value={password} onChange={(e) => setPassword(e.target.value)} /></Row>
              <Row label="Message of the day"><input className="input" style={{ width: 300 }} value={motd} onChange={(e) => setMotd(e.target.value)} /></Row>
              <Row label="Port" help="Default 7777. Each server on the machine needs its own port."><input className="input" type="number" style={{ width: 100 }} value={port} onChange={(e) => setPort(+e.target.value || 7777)} /></Row>
            </Section>
          </>
        )}

        {step === 4 && (
          <>
            <h2 className="wiz-h">Automation</h2>
            <Section title="Reliability">
              <Row label="Start when the machine boots"><Switch on={autoStart} onChange={setAutoStart} /></Row>
              <Row label="Restart automatically after a crash"><Switch on={crash} onChange={setCrash} /></Row>
            </Section>
            <Section title="Backups"><Row label="Back up worlds"><ScheduleEditor value={bak} onChange={setBak} /></Row></Section>
            <Section title="Finish"><Row label="Start the server when done"><Switch on={startNow} onChange={setStartNow} /></Row></Section>
          </>
        )}
      </div>
      <div className="row" style={{ padding: 12, borderTop: '1px solid var(--border)' }}>
        <button className="btn" onClick={onCancel}>Cancel</button>
        <div className="grow" />
        {step > 0 && <button className="btn" onClick={() => setStep(step - 1)}><ChevronLeft size={13} /> Back</button>}
        {step < STEPS.length - 1 ? (
          <button className="btn primary" disabled={!valid[step]} onClick={() => setStep(step + 1)}>Continue <ChevronRight size={13} /></button>
        ) : (
          <button className="btn primary" disabled={!valid.every(Boolean) || runner.busy} onClick={create}><Rocket size={13} /> Create Server</button>
        )}
      </div>
      {runner.el}
    </div>
  )
}
