import { useEffect, useMemo, useState } from 'react'
import { FileCode, Save, Search, Trash2, RotateCcw } from 'lucide-react'
import { api } from '../../lib/api'
import { toast } from '../../lib/store'
import { PropDef, PROPS, PROP_BY_KEY, PROP_GROUPS, parseProps, serializeProps } from '../../lib/mc/properties'
import { describeSchedule, installJavaScript, JavaInstall, listJava, McConfig, parseSize } from '../../lib/mc/server'
import { javaFor, SOFTWARE, temurinUrl } from '../../lib/mc/apis'
import { openInEditor } from '../../lib/actions'
import { Segmented, Spinner, Switch } from '../../components/ui'
import { Row, ScheduleEditor, Section, useCtx } from './common'

export function PropControl({ def, value, onChange }: { def: PropDef; value: string; onChange: (v: string) => void }) {
  if (def.type === 'bool') return <Switch on={value === 'true'} onChange={(v) => onChange(String(v))} />
  if (def.type === 'enum')
    return (
      <select className="select" style={{ width: 240 }} value={value} onChange={(e) => onChange(e.target.value)}>
        {!def.options!.some((o) => o.value === value) && <option value={value}>{value || '(empty)'}</option>}
        {def.options!.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    )
  if (def.type === 'int')
    return (
      <span className="row">
        <input className="input" type="number" min={def.min} max={def.max} style={{ width: 110 }} value={value} onChange={(e) => onChange(e.target.value)} />
        {def.unit && <span className="small muted" style={{ width: 44 }}>{def.unit}</span>}
      </span>
    )
  if (def.type === 'text') return <textarea className="textarea" rows={2} style={{ width: 300 }} value={value} onChange={(e) => onChange(e.target.value)} />
  return <input className="input" style={{ width: 300 }} value={value} onChange={(e) => onChange(e.target.value)} />
}

type Pane = 'properties' | 'startup' | 'automation' | 'files'

export function SettingsTab({ onDelete }: { onDelete: () => void }) {
  const [pane, setPane] = useState<Pane>('properties')
  return (
    <>
      <div className="row" style={{ padding: '8px 16px', borderBottom: '1px solid var(--border)', justifyContent: 'center' }}>
        <Segmented
          value={pane}
          onChange={setPane}
          options={[
            { value: 'properties', label: 'server.properties' },
            { value: 'startup', label: 'Startup & Java' },
            { value: 'automation', label: 'Automation' },
            { value: 'files', label: 'Config Files' },
          ]}
        />
      </div>
      {pane === 'properties' && <PropertiesPane />}
      {pane === 'startup' && <StartupPane />}
      {pane === 'automation' && <AutomationPane />}
      {pane === 'files' && <FilesPane onDelete={onDelete} />}
    </>
  )
}

// ---------------------------------------------------------------------------
function PropertiesPane() {
  const { srv } = useCtx()
  const [orig, setOrig] = useState<string | null>(null)
  const [values, setValues] = useState<Record<string, string>>({})
  const [saved, setSaved] = useState<Record<string, string>>({})
  const [q, setQ] = useState('')
  const [saving, setSaving] = useState(false)
  const path = `${srv.dir}/server.properties`

  const load = async () => {
    const t = await api.fs.readText(srv.hostId, path).catch(() => '')
    const p = parseProps(t)
    setOrig(t)
    setValues(p.values)
    setSaved(p.values)
  }
  useEffect(() => { load() }, [srv.dir]) // eslint-disable-line

  const dirty = Object.keys({ ...values, ...saved }).filter((k) => values[k] !== saved[k])
  const needRestart = dirty.some((k) => PROP_BY_KEY[k]?.restart) || dirty.length > 0

  const save = async () => {
    if (orig === null) return
    setSaving(true)
    try {
      await api.fs.writeText(srv.hostId, path, serializeProps(orig, values))
      toast({ title: 'server.properties saved', body: srv.running && needRestart ? 'Restart the server to apply the changes.' : undefined, kind: 'success' })
      await load()
    } catch (e: any) {
      toast({ title: 'Save failed', body: e.message, kind: 'error' })
    } finally {
      setSaving(false)
    }
  }

  const ql = q.toLowerCase()
  const match = (d: PropDef) => !ql || d.key.includes(ql) || d.label.toLowerCase().includes(ql) || d.help.toLowerCase().includes(ql)
  const known = new Set(PROPS.map((p) => p.key))
  const unknown = Object.keys(values).filter((k) => !known.has(k) && (!ql || k.includes(ql)))

  if (orig === null) return <div className="empty"><Spinner size={22} /></div>

  return (
    <>
      <div className="row" style={{ padding: '8px 16px', borderBottom: '1px solid var(--border)' }}>
        <div className="search" style={{ width: 260 }}>
          <Search size={13} />
          <input placeholder="Search settings and help" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="grow small muted">{dirty.length ? `${dirty.length} unsaved change${dirty.length > 1 ? 's' : ''}${srv.running ? ' · restart required' : ''}` : 'Changes apply after restarting the server'}</div>
        <button className="btn" disabled={!dirty.length} onClick={() => setValues(saved)}><RotateCcw size={12} /> Revert</button>
        <button className="btn" onClick={() => openInEditor(srv.hostId, path)}><FileCode size={12} /> Edit as Text</button>
        <button className="btn primary" disabled={!dirty.length || saving} onClick={save}>{saving ? <Spinner size={12} /> : <Save size={12} />} Save</button>
      </div>
      <div className="grow scroll pad" style={{ maxWidth: 860, width: '100%', margin: '0 auto' }}>
        {PROP_GROUPS.map((g) => {
          const defs = PROPS.filter((p) => p.group === g && match(p))
          if (!defs.length) return null
          return (
            <Section key={g} title={g}>
              {defs.map((d) => {
                const present = d.key in values
                const v = present ? values[d.key] : d.def
                return (
                  <Row
                    key={d.key}
                    label={<span>{d.label}{values[d.key] !== saved[d.key] && <span style={{ color: 'var(--accent)' }}> •</span>}</span>}
                    help={`${d.help}\n\nKey: ${d.key} · default: ${d.def || '(empty)'}${d.restart ? ' · needs restart' : ''}`}
                    sub={<span className="mono">{d.key}{!present ? ' (not set, using default)' : ''}</span>}
                  >
                    <PropControl def={d} value={v} onChange={(nv) => setValues((x) => ({ ...x, [d.key]: nv }))} />
                  </Row>
                )
              })}
            </Section>
          )
        })}
        {unknown.length > 0 && (
          <Section title="Other settings" help="Keys in your file that SSH OS has no description for (newer versions or mods). You can still edit them.">
            {unknown.map((k) => (
              <Row key={k} label={<span className="mono">{k}</span>}>
                <input className="input" style={{ width: 300 }} value={values[k]} onChange={(e) => setValues((x) => ({ ...x, [k]: e.target.value }))} />
              </Row>
            ))}
          </Section>
        )}
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
function StartupPane() {
  const { srv, saveCfg, task } = useCtx()
  const [c, setC] = useState<McConfig>(srv.config)
  const [sys, setSys] = useState<Awaited<ReturnType<typeof listJava>> | null>(null)
  const [need, setNeed] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)
  useEffect(() => setC(srv.config), [srv.config])
  useEffect(() => {
    listJava(srv.hostId).then(setSys)
    if (srv.config.mcVersion) javaFor(srv.config.mcVersion).then(setNeed)
  }, [srv.hostId, srv.config.mcVersion])
  const set = (p: Partial<McConfig>) => setC((x) => ({ ...x, ...p }))
  const memMb = sys ? Math.floor(sys.memTotal / 1024 / 1024) : 8192
  const xmxMb = parseSize(c.xmx)
  const dirty = JSON.stringify(c) !== JSON.stringify(srv.config)

  const save = async () => {
    setSaving(true)
    try {
      await saveCfg(c)
      toast({ title: 'Startup settings saved', body: srv.running ? 'They apply the next time the server starts.' : undefined, kind: 'success' })
    } catch (e: any) {
      toast({ title: 'Save failed', body: e.message, kind: 'error' })
    } finally {
      setSaving(false)
    }
  }

  const installJava = async (major: number) => {
    if (!sys) return
    const r = await task(`Installing Java ${major}`, installJavaScript(major, temurinUrl(major, sys.arch)))
    const m = r.output.match(/JAVA_PATH=(\S+)/)
    if (m) {
      set({ java: m[1] })
      setSys(await listJava(srv.hostId))
    }
  }

  const javaMajor = (p: string): JavaInstall | undefined => sys?.installs.find((j) => j.path === p) ?? (p === 'java' ? sys?.installs[0] : undefined)
  const cur = javaMajor(c.java)

  if (!srv.managed) return <div className="empty">Set up management (button above) to change startup settings.</div>

  return (
    <>
      <SaveBar dirty={dirty} saving={saving} onSave={save} onRevert={() => setC(srv.config)} />
      <div className="grow scroll pad" style={{ maxWidth: 860, width: '100%', margin: '0 auto' }}>
        <Section title="Java runtime" help="The Java installation used to run the server. Newer Minecraft versions require newer Java.">
          <Row label="Java executable" sub={need ? `${SOFTWARE[c.software]?.name} ${c.mcVersion} needs Java ${need}+${cur ? ` · selected: Java ${cur.major}` : ''}` : undefined}>
            <select className="select" style={{ width: 360 }} value={c.java} onChange={(e) => set({ java: e.target.value })}>
              {!sys?.installs.some((j) => j.path === c.java) && <option value={c.java}>{c.java}</option>}
              {sys?.installs.map((j) => <option key={j.path} value={j.path}>Java {j.major} ({j.label}): {j.path}</option>)}
            </select>
          </Row>
          {cur && need && cur.major < need && <div className="small" style={{ color: 'var(--red)', padding: '4px 0 8px' }}>The selected Java is too old. The server will fail with UnsupportedClassVersionError.</div>}
          <Row label="Install another Java" help="Downloads Eclipse Temurin JRE into ~/.sshos/java. No root needed; the system Java is not changed.">
            {[need ?? 21, 25, 21, 17].filter((v, i, a) => a.indexOf(v) === i).map((m) => (
              <button key={m} className="btn" onClick={() => installJava(m)}>Java {m}</button>
            ))}
          </Row>
        </Section>

        <Section title="Memory" help="See Help → Memory. Setting minimum = maximum is recommended.">
          <Row label="Maximum memory (-Xmx)" sub={`Machine has ${(memMb / 1024).toFixed(1)} GB`}>
            <input type="range" min={512} max={Math.max(1024, memMb - 256)} step={256} value={xmxMb} onChange={(e) => set({ xmx: `${e.target.value}M`, xms: c.xms === c.xmx ? `${e.target.value}M` : c.xms })} style={{ width: 200 }} />
            <input className="input mono" style={{ width: 80 }} value={c.xmx} onChange={(e) => set({ xmx: e.target.value })} />
          </Row>
          <Row label="Minimum memory (-Xms)" help="Memory reserved at start. Equal to maximum is best for dedicated machines.">
            <button className="btn" onClick={() => set({ xms: c.xmx })}>Same as max</button>
            <input className="input mono" style={{ width: 80 }} value={c.xms} onChange={(e) => set({ xms: e.target.value })} />
          </Row>
          {xmxMb > memMb - 1024 && <div className="small" style={{ color: 'var(--orange)', padding: '4px 0 8px' }}>Leaves less than 1 GB for the operating system.</div>}
        </Section>

        <Section title="Launch">
          <Row label="Start mode" help="Jar: SSH OS runs java -jar with the options below. Custom command: for Forge/NeoForge (run.sh) or special launchers.">
            <Segmented value={c.startMode} onChange={(v) => set({ startMode: v })} options={[{ value: 'jar', label: 'Server jar' }, { value: 'custom', label: 'Custom command' }]} />
          </Row>
          {c.startMode === 'jar' ? (
            <>
              <Row label="Server jar" help="The jar file in the server folder. Updated automatically by the updater.">
                <input className="input mono" style={{ width: 320 }} value={c.jar} onChange={(e) => set({ jar: e.target.value })} />
              </Row>
              <Row label="JVM flags preset" help="Garbage collector tuning. Aikar's flags are the standard for Paper. Paper recommended uses the flags PaperMC publishes for your version.">
                <select className="select" style={{ width: 220 }} value={c.flagsPreset} onChange={(e) => set({ flagsPreset: e.target.value as any })}>
                  <option value="aikar">Aikar’s flags</option>
                  {c.paperFlags && <option value="paper">Paper recommended</option>}
                  <option value="none">None</option>
                </select>
              </Row>
              <Row label="Extra JVM arguments" help="Added after the preset, e.g. -Dfile.encoding=UTF-8 or -XX:+UseZGC. Do not add -Xmx here.">
                <input className="input mono" style={{ width: 360 }} placeholder="-Dfile.encoding=UTF-8" value={c.extraJvm} onChange={(e) => set({ extraJvm: e.target.value })} />
              </Row>
              <Row label="Server arguments" help="Passed to the server after -jar. --nogui (Paper) or nogui (vanilla/Fabric) disables the Java window. Other examples: --port 25566, --world-dir worlds.">
                <input className="input mono" style={{ width: 240 }} value={c.serverArgs} onChange={(e) => set({ serverArgs: e.target.value })} />
              </Row>
            </>
          ) : (
            <Row label="Command" help="Run inside the server folder. Example for Forge/NeoForge: sh run.sh nogui. Put JVM memory options in user_jvm_args.txt for those.">
              <input className="input mono" style={{ width: 360 }} value={c.customCmd} onChange={(e) => set({ customCmd: e.target.value })} />
            </Row>
          )}
          <div className="small muted mono" style={{ padding: '8px 0', wordBreak: 'break-all' }}>
            {c.startMode === 'jar' ? `${c.java} -Xms${c.xms} -Xmx${c.xmx} ${c.flagsPreset !== 'none' ? `<${c.flagsPreset} flags> ` : ''}${c.extraJvm} -jar ${c.jar} ${c.serverArgs}` : c.customCmd}
          </div>
        </Section>

        <Section title="Stopping">
          <Row label="Warn players before stopping" help="Broadcasts 'Server is stopping in N seconds' and waits before /stop. 0 = stop immediately.">
            <input className="input" type="number" min={0} max={600} style={{ width: 80 }} value={c.stopWarnSeconds} onChange={(e) => set({ stopWarnSeconds: +e.target.value })} /> s
          </Row>
          <Row label="Force stop after" help="If the server hasn't stopped this long after /stop, it is terminated (and killed 15 s later).">
            <input className="input" type="number" min={10} max={900} style={{ width: 80 }} value={c.stopTimeout} onChange={(e) => set({ stopTimeout: +e.target.value })} /> s
          </Row>
          <Row label="Background session name" help={`tmux/screen session name. Attach in Terminal with: tmux attach -t ${c.session}`}>
            <input className="input mono" style={{ width: 200 }} value={c.session} onChange={(e) => set({ session: e.target.value.replace(/[^\w.-]/g, '') })} />
          </Row>
        </Section>

        <Section title="Identity">
          <Row label="Display name"><input className="input" style={{ width: 240 }} value={c.name} onChange={(e) => set({ name: e.target.value })} /></Row>
          <Row label="Software" help="Detected or chosen server software. Only change this if detection was wrong; it affects updates and which add-ons are offered.">
            <select className="select" style={{ width: 160 }} value={c.software} onChange={(e) => set({ software: e.target.value as any })}>
              {Object.values(SOFTWARE).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </Row>
          <Row label="Minecraft version" help="Used for updates and to find compatible add-ons. Change versions from the Updates tab instead.">
            <input className="input mono" style={{ width: 120 }} value={c.mcVersion} onChange={(e) => set({ mcVersion: e.target.value })} />
          </Row>
        </Section>
      </div>
    </>
  )
}

function SaveBar({ dirty, saving, onSave, onRevert }: { dirty: boolean; saving: boolean; onSave: () => void; onRevert: () => void }) {
  return (
    <div className="row" style={{ padding: '8px 16px', borderBottom: '1px solid var(--border)' }}>
      <div className="grow small muted">{dirty ? 'Unsaved changes' : 'All changes saved'}</div>
      <button className="btn" disabled={!dirty} onClick={onRevert}><RotateCcw size={12} /> Revert</button>
      <button className="btn primary" disabled={!dirty || saving} onClick={onSave}>{saving ? <Spinner size={12} /> : <Save size={12} />} Save</button>
    </div>
  )
}

// ---------------------------------------------------------------------------
function AutomationPane() {
  const { srv, saveCfg } = useCtx()
  const [c, setC] = useState<McConfig>(srv.config)
  const [saving, setSaving] = useState(false)
  const [cron, setCron] = useState<string | null>(null)
  useEffect(() => setC(srv.config), [srv.config])
  const set = (p: Partial<McConfig>) => setC((x) => ({ ...x, ...p }))
  const dirty = JSON.stringify(c) !== JSON.stringify(srv.config)
  const loadCron = () => api.exec(srv.hostId, `crontab -l 2>/dev/null | grep -F 'sshos-mc:${srv.config.id}' || true`).then((r) => setCron(r.stdout.trim()))
  useEffect(() => { loadCron() }, [srv.config]) // eslint-disable-line

  const save = async () => {
    setSaving(true)
    try {
      await saveCfg(c)
      toast({ title: 'Automation saved', kind: 'success' })
    } catch (e: any) {
      toast({ title: 'Save failed', body: e.message, kind: 'error' })
    } finally {
      setSaving(false)
    }
  }

  if (!srv.managed) return <div className="empty">Set up management (button above) to use automation.</div>

  return (
    <>
      <SaveBar dirty={dirty} saving={saving} onSave={save} onRevert={() => setC(srv.config)} />
      <div className="grow scroll pad" style={{ maxWidth: 860, width: '100%', margin: '0 auto' }}>
        <Section title="Availability">
          <Row label="Start when the machine boots" help="Adds an @reboot entry to your user crontab (needs cron)."><Switch on={c.autoStart} onChange={(v) => set({ autoStart: v })} /></Row>
          <Row label="Restart after a crash" help="Restart the server 10 seconds after it exits unexpectedly."><Switch on={c.restartOnCrash} onChange={(v) => set({ restartOnCrash: v })} /></Row>
          <Row label="Give up after" help="Maximum automatic restarts in a row before giving up (prevents endless crash loops).">
            <input className="input" type="number" min={1} max={100} style={{ width: 70 }} value={c.maxCrashRestarts} onChange={(e) => set({ maxCrashRestarts: +e.target.value })} /> attempts
          </Row>
          <Row label="Scheduled restart" help="Restart regularly (only while running), with a 60-second warning. Helps long-running modded servers stay smooth." sub={describeSchedule(c.restartSchedule)}>
            <ScheduleEditor value={c.restartSchedule} onChange={(s) => set({ restartSchedule: s })} />
          </Row>
        </Section>
        <Section title="Updates" help="See the Updates tab for details and to update right now.">
          <Row label="Update schedule" sub={describeSchedule(c.updates.schedule)}>
            <ScheduleEditor value={c.updates.schedule} onChange={(s) => set({ updates: { ...c.updates, schedule: s } })} />
          </Row>
          <Row label="Update server software" help={SOFTWARE[c.software]?.autoUpdate ? 'Newest build of your Minecraft version.' : `${SOFTWARE[c.software]?.name} cannot be updated automatically.`}>
            <Switch on={c.updates.server && !!SOFTWARE[c.software]?.autoUpdate} onChange={(v) => set({ updates: { ...c.updates, server: v } })} />
          </Row>
          <Row label="Update plugins, mods & data packs"><Switch on={c.updates.content} onChange={(v) => set({ updates: { ...c.updates, content: v } })} /></Row>
          <Row label="Follow new Minecraft versions" help="DANGEROUS: also upgrades to new Minecraft versions. Worlds cannot be downgraded afterwards and plugins may break. Keep backups.">
            <Switch on={c.updates.followLatest} onChange={(v) => set({ updates: { ...c.updates, followLatest: v } })} />
          </Row>
          <Row label="After an update">
            <select className="select" style={{ width: 230 }} value={c.updates.restart} onChange={(e) => set({ updates: { ...c.updates, restart: e.target.value as any } })}>
              <option value="never">Apply at next restart</option>
              <option value="always">Restart now (30 s warning)</option>
            </select>
          </Row>
        </Section>
        <Section title="Backups">
          <Row label="Backup schedule" sub={describeSchedule(c.backups.schedule)}>
            <ScheduleEditor value={c.backups.schedule} onChange={(s) => set({ backups: { ...c.backups, schedule: s } })} />
          </Row>
          <Row label="What to back up" help="Worlds: overworld, nether and end only (small). Full: the whole server folder including plugins and configs.">
            <Segmented value={c.backups.scope} onChange={(v) => set({ backups: { ...c.backups, scope: v } })} options={[{ value: 'worlds', label: 'Worlds' }, { value: 'full', label: 'Full server' }]} />
          </Row>
          <Row label="Keep newest"><input className="input" type="number" min={1} max={500} style={{ width: 70 }} value={c.backups.keep} onChange={(e) => set({ backups: { ...c.backups, keep: +e.target.value || 1 } })} /> backups</Row>
          <Row label="Backup folder" help="Relative to the server folder, or an absolute path (e.g. a USB drive or network share mounted at /mnt/backup).">
            <input className="input mono" style={{ width: 240 }} value={c.backups.dir} onChange={(e) => set({ backups: { ...c.backups, dir: e.target.value } })} />
          </Row>
        </Section>
        <Section title="Installed schedule (crontab)" help="What is currently installed in your crontab for this server.">
          <pre className="output" style={{ margin: 0, padding: '10px 0', background: 'transparent' }}>{cron === null ? '…' : cron || 'No scheduled tasks'}</pre>
        </Section>
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
const CONFIG_FILES: { path: string; label: string; help: string }[] = [
  { path: 'server.properties', label: 'server.properties', help: 'Core Minecraft settings (also editable in the first pane).' },
  { path: 'eula.txt', label: 'eula.txt', help: 'Minecraft EULA acceptance.' },
  { path: 'bukkit.yml', label: 'bukkit.yml', help: 'Spawn limits, chunk GC, ticks-per spawns, aliases.' },
  { path: 'spigot.yml', label: 'spigot.yml', help: 'Entity activation range, merge radius, view distance per world, restart script.' },
  { path: 'config/paper-global.yml', label: 'paper-global.yml', help: 'Paper global settings: proxies (Velocity secret), chunk loading, timings, anti-xray toggles.' },
  { path: 'config/paper-world-defaults.yml', label: 'paper-world-defaults.yml', help: 'Paper per-world defaults: anti-xray, entity limits, despawn ranges, redstone implementation.' },
  { path: 'purpur.yml', label: 'purpur.yml', help: 'Purpur gameplay options (only on Purpur).' },
  { path: 'commands.yml', label: 'commands.yml', help: 'Command aliases.' },
  { path: 'permissions.yml', label: 'permissions.yml', help: 'Basic permission definitions (most servers use LuckPerms instead).' },
  { path: 'help.yml', label: 'help.yml', help: 'Customize /help topics.' },
  { path: 'ops.json', label: 'ops.json', help: 'Operators. Better managed in the Players tab.' },
  { path: 'whitelist.json', label: 'whitelist.json', help: 'Whitelisted players.' },
  { path: 'banned-players.json', label: 'banned-players.json', help: 'Banned players.' },
  { path: 'banned-ips.json', label: 'banned-ips.json', help: 'Banned IPs.' },
  { path: 'config/fabric_loader_dependencies.json', label: 'fabric_loader_dependencies.json', help: 'Fabric dependency overrides.' },
  { path: 'user_jvm_args.txt', label: 'user_jvm_args.txt', help: 'Forge/NeoForge JVM arguments (memory goes here for run.sh servers).' },
]

function FilesPane({ onDelete }: { onDelete: () => void }) {
  const { srv } = useCtx()
  const [exists, setExists] = useState<Set<string> | null>(null)
  useEffect(() => {
    api.exec(srv.hostId, `cd '${srv.dir.replace(/'/g, `'\\''`)}' && for f in ${CONFIG_FILES.map((f) => f.path).join(' ')}; do [ -f "$f" ] && echo "$f"; done; ls config/*.yml config/*.json config/*.toml 2>/dev/null | head -60`).then((r) =>
      setExists(new Set(r.stdout.split('\n').filter(Boolean))),
    )
  }, [srv.dir, srv.hostId])
  const extra = useMemo(() => [...(exists ?? [])].filter((p) => !CONFIG_FILES.some((f) => f.path === p)), [exists])
  return (
    <div className="grow scroll pad" style={{ maxWidth: 860, width: '100%', margin: '0 auto' }}>
      <Section title="Configuration files" help="Opens the file in the Code Editor. Most changes require a restart.">
        {CONFIG_FILES.filter((f) => exists?.has(f.path)).map((f) => (
          <Row key={f.path} label={<span className="mono">{f.label}</span>} sub={f.help}>
            <button className="btn" onClick={() => openInEditor(srv.hostId, `${srv.dir}/${f.path}`)}><FileCode size={12} /> Edit</button>
          </Row>
        ))}
        {exists === null && <div style={{ padding: 10 }}><Spinner size={14} /></div>}
      </Section>
      {extra.length > 0 && (
        <Section title="Other config files (config/)">
          {extra.map((p) => (
            <Row key={p} label={<span className="mono">{p}</span>}>
              <button className="btn" onClick={() => openInEditor(srv.hostId, `${srv.dir}/${p}`)}><FileCode size={12} /> Edit</button>
            </Row>
          ))}
        </Section>
      )}
      <Section title="Danger zone">
        <Row label="Delete this server" help="Stops the server, removes its scheduled tasks and deletes the whole folder including worlds and backups inside it. You must type the server name to confirm." sub="Download a backup first if you might need the world again.">
          <button className="btn danger" onClick={onDelete}><Trash2 size={12} /> Delete Server…</button>
        </Row>
      </Section>
    </div>
  )
}
