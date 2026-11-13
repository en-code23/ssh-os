import { useEffect, useMemo, useState } from 'react'
import { Check, ChevronLeft, ChevronRight, ExternalLink, Info, Rocket } from 'lucide-react'
import { api, shq } from '../../lib/api'
import { toast, useStore } from '../../lib/store'
import { useMc, scanHost, addExtraDir } from '../../lib/mc/store'
import { listVersions, resolveServerJar, Software, SOFTWARE, McVersion, javaFor, temurinUrl, mojangUuid } from '../../lib/mc/apis'
import { defaultConfig, safeFileName, fetchCmd, installJavaScript, listJava, Schedule, writeManagement, ctl, JavaInstall } from '../../lib/mc/server'
import { PROP_BY_KEY } from '../../lib/mc/properties'
import { PLAYER_PRESETS, tune } from '../../lib/mc/tuning'
import { latestStable } from '../../lib/mc/apis'
import { Spinner, Switch } from '../../components/ui'
import { Row, ScheduleEditor, Section, useTaskRunner } from './common'
import { McIcon } from './Minecraft'
import { PropControl } from './Settings'
import { SeedInput, WebsiteFields, setupWebsite, websiteFormValid, type WebsiteForm } from './Website'

const STEPS = ['Basics', 'Software', 'Players', 'Gameplay', 'Performance', 'Automation'] as const

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'server'

export function NewServer({ hostId: initialHost, onCancel, onCreated }: { hostId?: string; onCancel: () => void; onCreated: (hostId: string, dir: string) => void }) {
  const servers = useStore((s) => s.servers)
  const conns = useStore((s) => s.conns)
  const mc = useMc((s) => s.servers)
  const hosts = servers.filter((s) => s.protocol === 'ssh' && conns[s.id]?.status === 'connected')
  const [hostId, setHostId] = useState(initialHost && hosts.some((h) => h.id === initialHost) ? initialHost : hosts[0]?.id)
  const runner = useTaskRunner(hostId ?? '')
  const home = hostId ? conns[hostId]?.home ?? '~' : '~'

  const [step, setStep] = useState(0)
  const [name, setName] = useState('Survival')
  const [dir, setDir] = useState('')
  const [dirTouched, setDirTouched] = useState(false)
  const [software, setSoftware] = useState<Software>('paper')
  const [versions, setVersions] = useState<McVersion[] | null>(null)
  const [showUnstable, setShowUnstable] = useState(false)
  const [version, setVersion] = useState('')
  const [javaNeed, setJavaNeed] = useState<number | null>(null)
  const [sys, setSys] = useState<Awaited<ReturnType<typeof listJava>> | null>(null)
  const [javaChoice, setJavaChoice] = useState<string>('auto')
  const [props, setProps] = useState<Record<string, string>>({
    motd: 'A Minecraft Server', 'max-players': '20', gamemode: 'survival', difficulty: 'normal', hardcore: 'false', pvp: 'true',
    'online-mode': 'true', 'white-list': 'false', 'level-seed': '', 'level-type': 'minecraft:normal', 'view-distance': '10',
    'simulation-distance': '10', 'server-port': '25565', 'spawn-protection': '16', 'enable-command-block': 'false', 'allow-flight': 'false',
  })
  const [xmx, setXmx] = useState(2048)
  const [xmsEqual, setXmsEqual] = useState(true)
  const [flags, setFlags] = useState<'paper' | 'aikar' | 'none'>('paper')
  const [opName, setOpName] = useState('')
  const [autoStart, setAutoStart] = useState(true)
  const [crash, setCrash] = useState(true)
  const [updSched, setUpdSched] = useState<Schedule>({ kind: 'daily', time: '04:30' })
  const [updContent, setUpdContent] = useState(false)
  const [updRestart, setUpdRestart] = useState<'never' | 'always'>('never')
  const [bakSched, setBakSched] = useState<Schedule>({ kind: 'daily', time: '04:00' })
  const [bakKeep, setBakKeep] = useState(7)
  const [startNow, setStartNow] = useState(true)
  const [eula, setEula] = useState(false)
  const [portBusy, setPortBusy] = useState(false)
  const [web, setWeb] = useState<WebsiteForm>({ enabled: true, port: 26565, player: '', admin: '' })
  const [players, setPlayers] = useState(5)

  // defaults that depend on the host
  useEffect(() => {
    if (!hostId) return
    setSys(null)
    listJava(hostId).then((s) => {
      setSys(s)
    })
    const used = (mc[hostId] ?? []).map((s) => s.port)
    let p = 25565
    while (used.includes(p)) p++
    setProps((x) => ({ ...x, 'server-port': String(p) }))
    setWeb((w) => ({ ...w, port: p + 1000 }))
  }, [hostId]) // eslint-disable-line

  useEffect(() => {
    if (!dirTouched) setDir(`${home}/minecraft/${slug(name)}`)
  }, [name, home, dirTouched])

  useEffect(() => {
    setVersions(null)
    setVersion('')
    listVersions(software)
      .then((v) => {
        setVersions(v)
        // always default to the newest stable Minecraft version
        setVersion(latestStable(v)?.id ?? v[0]?.id ?? '')
      })
      .catch((e) => toast({ title: 'Could not load versions', body: e.message, kind: 'error' }))
    if (software !== 'paper') setFlags((f) => (f === 'paper' ? 'aikar' : f))
  }, [software])

  useEffect(() => {
    if (!version) return
    setJavaNeed(null)
    if (software === 'paper' || software === 'folia') resolveServerJar(software, version).then((d) => setJavaNeed(d.javaMin ?? null)).catch(() => javaFor(version).then(setJavaNeed))
    else javaFor(version).then(setJavaNeed)
  }, [version, software])

  useEffect(() => {
    if (!hostId) return
    const port = props['server-port']
    const t = setTimeout(() => {
      api.exec(hostId, `(ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null) | grep -qE '[:.]${parseInt(port) || 0}\\s' && echo BUSY || echo FREE`).then((r) => setPortBusy(r.stdout.includes('BUSY'))).catch(() => {})
    }, 400)
    return () => clearTimeout(t)
  }, [hostId, props['server-port']]) // eslint-disable-line

  // Size the server for the expected player count on this machine.
  const tuning = useMemo(() => (sys ? tune(players, software, Math.floor(sys.memTotal / 1024 / 1024), sys.cpus) : null), [players, software, sys])
  useEffect(() => {
    if (!tuning) return
    setXmx(tuning.xmxMb)
    setProps((p) => ({
      ...p,
      'max-players': String(players),
      'view-distance': String(tuning.viewDistance),
      'simulation-distance': String(tuning.simulationDistance),
    }))
  }, [tuning]) // eslint-disable-line

  const goodJava: JavaInstall | undefined = useMemo(
    () => sys?.installs.filter((j) => javaNeed && j.major >= javaNeed).sort((a, b) => a.major - b.major)[0],
    [sys, javaNeed],
  )
  const memMb = sys ? Math.floor(sys.memTotal / 1024 / 1024) : 0
  const shownVersions = (versions ?? []).filter((v) => showUnstable || v.stable)
  const existsName = hostId && (mc[hostId] ?? []).some((s) => s.dir === dir)

  const valid = [
    !!hostId && !!name.trim() && dir.startsWith('/') && !existsName,
    !!version,
    players >= 1,
    true,
    xmx >= 512,
    eula && websiteFormValid(web),
  ]

  const create = async () => {
    if (!hostId || !sys) return
    try {
      // 1. Java
      let javaPath = javaChoice === 'auto' ? goodJava?.path : javaChoice
      if (!javaPath || javaChoice === 'install') {
        const need = javaNeed ?? 21
        const r = await runner.run(`Installing Java ${need}`, installJavaScript(need, temurinUrl(need, sys.arch)))
        const m = r.output.match(/JAVA_PATH=(\S+)/)
        if (r.code !== 0 || !m) throw new Error('Java installation failed')
        javaPath = m[1]
      }
      // 2. Server jar
      const dl = await resolveServerJar(software, version)
      dl.fileName = safeFileName(dl.fileName, 'server.jar')
      const tool = dl.sha256 ? 'sha256sum' : 'sha1sum'
      const sum = dl.sha256 ?? dl.sha1
      const check = sum && /^[a-f0-9]{40,64}$/i.test(sum) ? `if command -v ${tool} >/dev/null; then echo ${shq(`${sum}  ${dl.fileName}`)} | ${tool} -c - || exit 4; fi` : 'true'
      const script = `set -e
D=${shq(dir)}
if [ -d "$D" ] && [ -n "$(ls -A "$D" 2>/dev/null)" ]; then echo "Folder $D already exists and is not empty"; exit 3; fi
mkdir -p "$D" && cd "$D"
echo ${shq(`Downloading ${SOFTWARE[software].name} ${version} (build ${dl.build})…`)}
${fetchCmd(dl.url, dl.fileName)}
echo "Verifying checksum…"; ${check}
mkdir -p plugins
echo "eula=true" > eula.txt
echo "Downloaded $(du -h ${shq(dl.fileName)} | cut -f1)"`
      const r = await runner.run(`Creating ${name}`, script)
      if (r.code !== 0) return

      // 3. Files
      const header = `#Minecraft server properties\n#Created by SSH OS ${new Date().toISOString()}\n`
      const body = Object.entries({ ...props, 'level-name': 'world', 'enforce-whitelist': props['white-list'] })
        .map(([k, v]) => `${k}=${v.replace(/\\/g, '\\\\').replace(/[^\x20-\x7e]/g, (ch) => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'))}`)
        .join('\n')
      await api.fs.writeText(hostId, `${dir}/server.properties`, header + body + '\n')
      if (opName.trim()) {
        const p = await mojangUuid(opName.trim()).catch(() => null)
        if (p) {
          await api.fs.writeText(hostId, `${dir}/ops.json`, JSON.stringify([{ uuid: p.id, name: p.name, level: 4, bypassesPlayerLimit: false }], null, 2))
          if (props['white-list'] === 'true') await api.fs.writeText(hostId, `${dir}/whitelist.json`, JSON.stringify([{ uuid: p.id, name: p.name }], null, 2))
        } else toast({ title: `Player “${opName}” not found`, body: 'You can add operators later in the Players tab.', kind: 'error' })
      }
      const xmxS = `${xmx}M`
      const cfg = defaultConfig({
        name: name.trim(),
        software,
        mcVersion: version,
        build: dl.build,
        jar: dl.fileName,
        java: javaPath,
        xmx: xmxS,
        xms: xmsEqual ? xmxS : '512M',
        flagsPreset: flags,
        paperFlags: dl.recommendedFlags?.join(' '),
        autoStart: autoStart && sys.cron,
        restartOnCrash: crash,
        updates: { server: updSched.kind !== 'off', content: updContent, followLatest: false, schedule: updSched, restart: updRestart },
        backups: { schedule: bakSched, keep: bakKeep, scope: 'worlds', dir: 'backups' },
      })
      await writeManagement(hostId, dir, cfg)
      addExtraDir(hostId, dir)
      try {
        const webCfg = await setupWebsite(hostId, dir, 'minecraft', name.trim(), web)
        if (webCfg) await writeManagement(hostId, dir, { ...cfg, web: webCfg })
      } catch (e: any) {
        toast({ title: 'Server created, but the website could not start', body: e.message, kind: 'error' })
      }
      if (startNow) {
        const s = await ctl(hostId, dir, 'start')
        if (s.code !== 0) toast({ title: 'Server created, but it did not start', body: (s.stdout + s.stderr).slice(-300), kind: 'error' })
      }
      await scanHost(hostId)
      toast({ title: `${name} is ready`, body: startNow ? 'The first start generates the world and can take a minute.' : 'Press Start when you are ready.', kind: 'success' })
      onCreated(hostId, dir)
    } catch (e: any) {
      toast({ title: 'Could not create the server', body: e.message, kind: 'error' })
    }
  }

  if (!hosts.length)
    return (
      <div className="empty">
        <h3>Connect to an SSH server first</h3>
        <div>Minecraft servers run on one of your Linux machines.</div>
        <button className="btn" onClick={onCancel}>Back</button>
      </div>
    )

  const propRow = (k: string) => {
    const d = PROP_BY_KEY[k]
    return (
      <Row key={k} label={d.label} help={d.help}>
        <PropControl def={d} value={props[k] ?? d.def} onChange={(v) => setProps((p) => ({ ...p, [k]: v }))} />
      </Row>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div className="wizard-steps">
        {STEPS.map((s, i) => (
          <button key={s} className={`${i === step ? 'on' : ''} ${i < step ? 'done' : ''}`} onClick={() => i <= step || valid.slice(0, i).every(Boolean) ? setStep(i) : null}>
            <span className="num">{i < step ? <Check size={11} /> : i + 1}</span> {s}
          </button>
        ))}
      </div>
      <div className="grow scroll pad" style={{ maxWidth: 760, width: '100%', margin: '0 auto' }}>
        {step === 0 && (
          <>
            <h2 className="wiz-h">Create a Minecraft server</h2>
            <p className="muted wiz-p">SSH OS downloads the server, sets it up to run in the background and keeps it updated. You can change everything later.</p>
            <Section title="Basics">
              <Row label="Machine" help="The SSH server the Minecraft server will run on. It needs enough free RAM (2 GB+) and disk space.">
                <select className="select" style={{ width: 240 }} value={hostId} onChange={(e) => setHostId(e.target.value)}>
                  {hosts.map((h) => <option key={h.id} value={h.id}>{h.name} ({h.host})</option>)}
                </select>
              </Row>
              <Row label="Server name" help="Shown in SSH OS and used for the folder and background session name. It is not shown to players (that is the MOTD).">
                <input className="input" style={{ width: 240 }} value={name} onChange={(e) => setName(e.target.value)} />
              </Row>
              <Row label="Folder" help="Where the server files live. Each server needs its own empty folder." sub={existsName ? <span style={{ color: 'var(--red)' }}>A server already exists in this folder</span> : undefined}>
                <input className="input mono" style={{ width: 340 }} value={dir} onChange={(e) => { setDir(e.target.value); setDirTouched(true) }} />
              </Row>
            </Section>
            {sys && (
              <div className="card small" style={{ lineHeight: 1.7 }}>
                <b>{hosts.find((h) => h.id === hostId)?.name}</b>: {(memMb / 1024).toFixed(1)} GB RAM · {sys.cpus} CPU cores · {sys.arch} ·
                Java: {sys.installs.length ? sys.installs.map((j) => j.major).join(', ') : 'not installed'} ·
                Background sessions: {sys.mux} · cron: {sys.cron ? 'yes' : 'no'} · python3: {sys.python ? 'yes' : 'no'}
                {!sys.python && <div style={{ color: 'var(--orange)' }}>python3 is missing: automatic updates won’t work until you install it (sudo apt install python3).</div>}
                {memMb < 1800 && <div style={{ color: 'var(--orange)' }}>This machine has little memory. Keep view distance low and expect only a few players.</div>}
              </div>
            )}
          </>
        )}

        {step === 1 && (
          <>
            <h2 className="wiz-h">Server software</h2>
            <p className="muted wiz-p">Paper is recommended for almost everyone. Pick Fabric only if you want mods.</p>
            <div className="sw-grid">
              {(['paper', 'purpur', 'fabric', 'vanilla', 'folia'] as Software[]).map((s) => (
                <button key={s} className={`sw-card ${software === s ? 'on' : ''}`} onClick={() => setSoftware(s)}>
                  <McIcon software={s} size={34} />
                  <div style={{ textAlign: 'left' }}>
                    <div className="row" style={{ gap: 6 }}>
                      <b>{SOFTWARE[s].name}</b>
                      {s === 'paper' && <span className="badge" style={{ color: 'var(--accent)' }}>Recommended</span>}
                    </div>
                    <div className="small muted">{SOFTWARE[s].blurb}</div>
                  </div>
                </button>
              ))}
            </div>
            <div className="card small" style={{ margin: '12px 0', lineHeight: 1.5 }}><Info size={12} /> {SOFTWARE[software].help}</div>
            <Section title="Minecraft version" help="Players must use the same Minecraft version (or a compatible one, if you add a plugin like ViaVersion). Newer versions need newer Java.">
              <Row label="Version" sub={javaNeed ? `Requires Java ${javaNeed} or newer` : undefined}>
                {versions ? (
                  <select className="select" style={{ width: 200 }} value={version} onChange={(e) => setVersion(e.target.value)}>
                    {shownVersions.slice(0, 120).map((v) => <option key={v.id} value={v.id}>{v.id}{v.id === latestStable(versions ?? [])?.id ? ' (latest)' : ''}{!v.stable ? ' (preview)' : ''}</option>)}
                  </select>
                ) : <Spinner size={14} />}
              </Row>
              <Row label="Show snapshots & pre-releases" help="Unstable test versions. They can corrupt worlds; never use them for a server you care about.">
                <Switch on={showUnstable} onChange={setShowUnstable} />
              </Row>
            </Section>
          </>
        )}

        {step === 2 && (
          <>
            <h2 className="wiz-h">How many players?</h2>
            <p className="muted wiz-p">SSH OS sizes memory, view distance and simulation distance for this many players on <b>{hosts.find((h) => h.id === hostId)?.name}</b>. You can fine-tune everything in the Performance step.</p>
            <div className="sw-grid">
              {PLAYER_PRESETS.map((p) => (
                <button key={p.players} className={`sw-card ${players === p.players ? 'on' : ''}`} onClick={() => setPlayers(p.players)}>
                  <div style={{ fontSize: 22, fontWeight: 700, minWidth: 74, textAlign: 'center' }}>{p.label}</div>
                  <div style={{ textAlign: 'left' }}>
                    <b>{p.label} players</b>
                    <div className="small muted">{p.hint}</div>
                  </div>
                </button>
              ))}
            </div>
            <Section title="Exact number">
              <Row label="Maximum players" help="Becomes max-players in server.properties. Players beyond this are told the server is full.">
                <input className="input" type="number" min={1} max={1000} style={{ width: 90 }} value={players} onChange={(e) => setPlayers(Math.max(1, Math.min(1000, +e.target.value || 1)))} />
              </Row>
            </Section>
            {!tuning ? <Spinner size={16} /> : (
              <div className="card" style={{ lineHeight: 1.6 }}>
                <b>Recommended for {players} player{players === 1 ? '' : 's'}</b>
                <div className="row" style={{ gap: 18, margin: '8px 0', flexWrap: 'wrap' }}>
                  <span><span className="muted">Memory</span> <b>{(tuning.xmxMb / 1024).toFixed(1)} GB</b></span>
                  <span><span className="muted">View distance</span> <b>{tuning.viewDistance}</b></span>
                  <span><span className="muted">Simulation distance</span> <b>{tuning.simulationDistance}</b></span>
                  <span><span className="muted">Machine</span> <b>{(memMb / 1024).toFixed(1)} GB · {sys?.cpus} cores</b></span>
                </div>
                {tuning.notes.map((n, i) => <div key={i} className="small muted">{n}</div>)}
                {tuning.warnings.map((w, i) => <div key={i} className="small" style={{ color: 'var(--orange)', marginTop: 4 }}>⚠ {w}</div>)}
              </div>
            )}
          </>
        )}

        {step === 3 && (
          <>
            <h2 className="wiz-h">Gameplay & players</h2>
            <p className="muted wiz-p">These go into server.properties. Click ? for an explanation of any setting.</p>
            <Section title="Server">{['motd', 'max-players', 'server-port'].map(propRow)}</Section>
            {portBusy && <div className="card small" style={{ color: 'var(--orange)', marginTop: -10, marginBottom: 14 }}>Port {props['server-port']} is already in use on this machine. Pick another port.</div>}
            <Section title="Gameplay">{['gamemode', 'difficulty', 'hardcore', 'pvp', 'allow-flight', 'spawn-protection', 'enable-command-block'].map(propRow)}</Section>
            <Section title="World">
              <Row label="Seed" help="Number or text. The same seed always creates the same world. Empty = random. Preview opens the seed on an interactive biome and structure map (Chunkbase).">
                <SeedInput game="minecraft" value={props['level-seed'] ?? ''} onChange={(v) => setProps((x) => ({ ...x, 'level-seed': v }))} />
              </Row>
              {['level-type'].map(propRow)}
            </Section>
            <Section title="Access">
              {['online-mode', 'white-list'].map(propRow)}
              <Row label="Make me operator" help="Your Minecraft username. You get full admin rights (op level 4) and are added to the whitelist if it is enabled.">
                <input className="input" style={{ width: 200 }} placeholder="Your Minecraft name" value={opName} onChange={(e) => setOpName(e.target.value)} />
              </Row>
            </Section>
          </>
        )}

        {step === 4 && (
          <>
            <h2 className="wiz-h">Performance & Java</h2>
            <Section title="Memory" help="Maximum RAM the server may use. Leave at least 1–1.5 GB for the operating system. More is not always faster.">
              <Row label="Maximum memory" sub={sys && tuning ? `This machine has ${(memMb / 1024).toFixed(1)} GB. Recommended for ${players} players: ${(tuning.xmxMb / 1024).toFixed(1)} GB` : undefined}>
                <input type="range" min={512} max={Math.max(1024, memMb - 512)} step={256} value={xmx} onChange={(e) => setXmx(+e.target.value)} style={{ width: 200 }} />
                <span className="mono" style={{ width: 64, textAlign: 'right' }}>{(xmx / 1024).toFixed(2)} GB</span>
              </Row>
              <Row label="Reserve all memory at start (-Xms = -Xmx)" help="Recommended by Paper and Aikar: avoids the heap growing/shrinking at runtime. Turn off on machines that run other important programs.">
                <Switch on={xmsEqual} onChange={setXmsEqual} />
              </Row>
              {xmx > memMb - 1024 && memMb > 0 && <div className="small" style={{ color: 'var(--orange)', padding: '6px 0' }}>Warning: this leaves under 1 GB for the system. The OS may kill the server.</div>}
            </Section>
            <Section title="Java runtime" help="Minecraft needs a recent Java. SSH OS can download Eclipse Temurin (free, open-source) into ~/.sshos/java without sudo.">
              <Row label="Java" sub={javaNeed ? `Required: Java ${javaNeed}+` : undefined}>
                <select className="select" style={{ width: 320 }} value={javaChoice} onChange={(e) => setJavaChoice(e.target.value)}>
                  <option value="auto">{goodJava ? `Automatic (Java ${goodJava.major}: ${goodJava.path})` : `Automatic (download Java ${javaNeed ?? ''})`}</option>
                  {sys?.installs.map((j) => (
                    <option key={j.path} value={j.path} disabled={!!javaNeed && j.major < javaNeed}>Java {j.major}: {j.path}{javaNeed && j.major < javaNeed ? ' (too old)' : ''}</option>
                  ))}
                  <option value="install">Download Java {javaNeed ?? ''} (Temurin)</option>
                </select>
              </Row>
            </Section>
            <Section title="View distances">{['view-distance', 'simulation-distance'].map(propRow)}</Section>
            <Section title="JVM flags">
              <Row label="Flags preset" help="Garbage-collector tuning. Aikar's flags (or Paper's recommended set) reduce lag spikes. Leave the default unless troubleshooting.">
                <select className="select" style={{ width: 220 }} value={flags} onChange={(e) => setFlags(e.target.value as any)}>
                  {(software === 'paper' || software === 'folia') && <option value="paper">Paper recommended</option>}
                  <option value="aikar">Aikar’s flags</option>
                  <option value="none">None</option>
                </select>
              </Row>
            </Section>
          </>
        )}

        {step === 5 && (
          <>
            <h2 className="wiz-h">Automation</h2>
            <Section title="Reliability">
              <Row label="Start when the machine boots" help="Adds an @reboot entry to your crontab." sub={!sys?.cron ? 'cron is not installed on this machine' : undefined}>
                <Switch on={autoStart && !!sys?.cron} onChange={setAutoStart} />
              </Row>
              <Row label="Restart automatically after a crash" help="If the server process exits without being stopped, it is restarted after 10 seconds (up to 5 times in a row).">
                <Switch on={crash} onChange={setCrash} />
              </Row>
            </Section>
            <Section title="Automatic updates" help="Installs new builds of the same Minecraft version (bug and security fixes). Needs python3 and cron on the machine.">
              <Row label="Update server software"><ScheduleEditor value={updSched} onChange={setUpdSched} /></Row>
              <Row label="Also update plugins/mods" help="Checks Modrinth, Hangar and SpigotMC for newer versions compatible with your Minecraft version."><Switch on={updContent} onChange={setUpdContent} /></Row>
              <Row label="After updating" help="Restart: players get a 30-second warning and the server restarts. Wait: updates are installed and take effect at the next restart.">
                <select className="select" style={{ width: 220 }} value={updRestart} onChange={(e) => setUpdRestart(e.target.value as any)}>
                  <option value="never">Wait for next restart</option>
                  <option value="always">Restart automatically</option>
                </select>
              </Row>
            </Section>
            <Section title="Backups">
              <Row label="Back up worlds"><ScheduleEditor value={bakSched} onChange={setBakSched} /></Row>
              <Row label="Keep" help="Older backups are deleted automatically.">
                <input className="input" type="number" min={1} max={200} style={{ width: 70 }} value={bakKeep} onChange={(e) => setBakKeep(+e.target.value || 1)} /> backups
              </Row>
            </Section>
            <WebsiteFields form={web} onChange={setWeb} gamePort={+props['server-port'] || 25565} />
            <Section title="Finish">
              <Row label="Start the server when done"><Switch on={startNow} onChange={setStartNow} /></Row>
              <Row
                label={<span>I accept the <a href="#" style={{ color: 'var(--accent)' }} onClick={(e) => { e.preventDefault(); api.openExternal('https://aka.ms/MinecraftEULA') }}>Minecraft EULA <ExternalLink size={10} /></a></span>}
                help="Mojang requires every server operator to accept the End User License Agreement. The server will not start without it."
              >
                <Switch on={eula} onChange={setEula} />
              </Row>
            </Section>
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
          <button className="btn primary" disabled={!valid.every(Boolean) || runner.busy || !sys} onClick={create}><Rocket size={13} /> Create Server</button>
        )}
      </div>
      {runner.el}
    </div>
  )
}
