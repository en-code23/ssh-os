import { useEffect, useMemo, useState } from 'react'
import { Archive, Download, Globe2, RefreshCw, RotateCcw, Search, Trash2, UserPlus, Upload, ArrowUpCircle, Play } from 'lucide-react'
import { api, shq } from '../../lib/api'
import { confirm, prompt, toast } from '../../lib/store'
import { ctl, describeSchedule, MC_DIR, run, safeFileName } from '../../lib/mc/server'
import { javaFor, listVersions, mojangUuid, resolveServerJar, SOFTWARE, McVersion } from '../../lib/mc/apis'
import { parseProps, serializeProps } from '../../lib/mc/properties'
import { HELP } from '../../lib/mc/help'
import { formatBytes } from '../../lib/files'
import { Spinner, Switch } from '../../components/ui'
import { Row, Section, useCtx } from './common'
import { useLive } from './Minecraft'

// ===========================================================================
// Players
// ===========================================================================
type ListKind = 'ops' | 'whitelist' | 'banned-players' | 'banned-ips'

const LISTS: { id: ListKind; label: string; help: string }[] = [
  { id: 'ops', label: 'Operators', help: 'Players with admin rights. Level 4 can use every command, including /stop.' },
  { id: 'whitelist', label: 'Whitelist', help: 'When the whitelist is on, only these players (and ops) can join.' },
  { id: 'banned-players', label: 'Banned players', help: 'Players who cannot join.' },
  { id: 'banned-ips', label: 'Banned IPs', help: 'IP addresses that cannot connect.' },
]

export function PlayersTab() {
  const { srv } = useCtx()
  const live = useLive(srv)
  const [lists, setLists] = useState<Record<ListKind, any[]> | null>(null)
  const [wl, setWl] = useState<{ on: boolean; enforce: boolean } | null>(null)
  const [add, setAdd] = useState<{ kind: ListKind; name: string }>({ kind: 'whitelist', name: '' })
  const canCmd = srv.running && srv.managed && !srv.external

  const load = async () => {
    const read = async (f: string) => {
      try { return JSON.parse(await api.fs.readText(srv.hostId, `${srv.dir}/${f}.json`)) } catch { return [] }
    }
    const [ops, whitelist, bp, bi] = await Promise.all(LISTS.map((l) => read(l.id)))
    setLists({ ops, whitelist, 'banned-players': bp, 'banned-ips': bi })
    const p = parseProps(await api.fs.readText(srv.hostId, `${srv.dir}/server.properties`).catch(() => '')).values
    setWl({ on: p['white-list'] === 'true', enforce: p['enforce-whitelist'] === 'true' })
  }
  useEffect(() => { load() }, [srv.dir]) // eslint-disable-line

  const cmd = async (c: string, quiet = false) => {
    const r = await ctl(srv.hostId, srv.dir, 'cmd', c)
    if (r.code !== 0) toast({ title: 'Command failed', body: (r.stdout + r.stderr).trim(), kind: 'error' })
    else if (!quiet) toast({ title: `/${c}`, kind: 'success' })
    setTimeout(load, 1500)
  }

  const writeList = async (kind: ListKind, data: any[]) => {
    await api.fs.writeText(srv.hostId, `${srv.dir}/${kind}.json`, JSON.stringify(data, null, 2))
    load()
  }

  const addEntry = async () => {
    const name = add.name.trim()
    if (!name) return
    if (canCmd) {
      const c = add.kind === 'ops' ? `op ${name}` : add.kind === 'whitelist' ? `whitelist add ${name}` : add.kind === 'banned-players' ? `ban ${name}` : `ban-ip ${name}`
      await cmd(c)
    } else {
      // offline edit
      const cur = lists?.[add.kind] ?? []
      if (add.kind === 'banned-ips') {
        await writeList(add.kind, [...cur, { ip: name, created: new Date().toISOString().replace('T', ' ').slice(0, 19) + ' +0000', source: 'SSH OS', expires: 'forever', reason: 'Banned by an operator.' }])
      } else {
        const p = await mojangUuid(name).catch(() => null)
        if (!p) return toast({ title: `Player “${name}” not found`, body: 'Check the spelling. Offline-mode servers can only be edited while running.', kind: 'error' })
        if (cur.some((e: any) => e.uuid === p.id)) return toast({ title: `${p.name} is already on the list` })
        const entry =
          add.kind === 'ops' ? { uuid: p.id, name: p.name, level: 4, bypassesPlayerLimit: false }
            : add.kind === 'whitelist' ? { uuid: p.id, name: p.name }
              : { uuid: p.id, name: p.name, created: new Date().toISOString().replace('T', ' ').slice(0, 19) + ' +0000', source: 'SSH OS', expires: 'forever', reason: 'Banned by an operator.' }
        await writeList(add.kind, [...cur, entry])
      }
      toast({ title: 'Saved', body: 'Takes effect when the server starts.', kind: 'success' })
    }
    setAdd((a) => ({ ...a, name: '' }))
  }

  const removeEntry = async (kind: ListKind, e: any) => {
    if (canCmd) {
      await cmd(kind === 'ops' ? `deop ${e.name}` : kind === 'whitelist' ? `whitelist remove ${e.name}` : kind === 'banned-players' ? `pardon ${e.name}` : `pardon-ip ${e.ip}`)
    } else {
      await writeList(kind, (lists?.[kind] ?? []).filter((x: any) => x !== e))
    }
  }

  const setWhitelist = async (on: boolean) => {
    if (canCmd) await cmd(`whitelist ${on ? 'on' : 'off'}`)
    const path = `${srv.dir}/server.properties`
    const t = await api.fs.readText(srv.hostId, path)
    await api.fs.writeText(srv.hostId, path, serializeProps(t, { 'white-list': String(on) }))
    load()
  }

  const online = live?.slp?.players
  return (
    <div className="grow scroll pad" style={{ maxWidth: 900, width: '100%', margin: '0 auto' }}>
      <Section title={`Online now${online ? ` · ${online.online}/${online.max}` : ''}`} help="Live list from the server status ping (shows up to 12 names). Actions send console commands.">
        {!srv.running && <div className="group-row muted">The server is stopped.</div>}
        {srv.running && !online?.sample?.length && <div className="group-row muted">{live ? 'Nobody is online.' : 'Loading…'}</div>}
        {online?.sample?.map((p) => (
          <div key={p.id} className="group-row">
            <div className="row">
              <img className="mc-head" src={`https://mc-heads.net/avatar/${p.id}/24`} alt="" onError={(e) => ((e.target as HTMLImageElement).style.visibility = 'hidden')} />
              <b>{p.name}</b>
            </div>
            <div className="row">
              <select className="select" style={{ width: 120 }} disabled={!canCmd} value="" onChange={(e) => e.target.value && cmd(`gamemode ${e.target.value} ${p.name}`)}>
                <option value="">Game mode…</option>
                {['survival', 'creative', 'adventure', 'spectator'].map((g) => <option key={g} value={g}>{g}</option>)}
              </select>
              <button className="btn" disabled={!canCmd} onClick={async () => { const m = await prompt(`Message ${p.name}`, '', undefined, 'Send'); if (m) cmd(`tell ${p.name} ${m}`) }}>Message</button>
              <button className="btn" disabled={!canCmd} onClick={() => cmd(`op ${p.name}`)}>Op</button>
              <button className="btn" disabled={!canCmd} onClick={async () => { const r = await prompt(`Kick ${p.name}`, 'Kicked by an operator', 'Reason shown to the player', 'Kick'); if (r !== null) cmd(`kick ${p.name} ${r}`) }}>Kick</button>
              <button className="btn danger" disabled={!canCmd} onClick={async () => { const r = await prompt(`Ban ${p.name}`, 'Banned by an operator', 'Reason shown to the player', 'Ban'); if (r !== null) cmd(`ban ${p.name} ${r}`) }}>Ban</button>
            </div>
          </div>
        ))}
      </Section>

      <Section title="Whitelist">
        <Row label="Whitelist enabled" help="Only listed players (and ops) can join. Add yourself first!"><Switch on={!!wl?.on} onChange={setWhitelist} /></Row>
        <Row label="Kick players who are not whitelisted" help="enforce-whitelist: removes online players who are not on the list when it changes.">
          <Switch on={!!wl?.enforce} onChange={async (v) => { const path = `${srv.dir}/server.properties`; const t = await api.fs.readText(srv.hostId, path); await api.fs.writeText(srv.hostId, path, serializeProps(t, { 'enforce-whitelist': String(v) })); load() }} />
        </Row>
      </Section>

      <Section title="Add player" help={canCmd ? 'Applied immediately with a console command.' : 'The server is stopped: SSH OS edits the JSON files directly using the Mojang UUID.'}>
        <div className="group-row">
          <div className="row grow">
            <select className="select" style={{ width: 170 }} value={add.kind} onChange={(e) => setAdd({ ...add, kind: e.target.value as ListKind })}>
              {LISTS.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
            </select>
            <input className="input grow" placeholder={add.kind === 'banned-ips' ? 'IP address' : 'Minecraft username'} value={add.name} onChange={(e) => setAdd({ ...add, name: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && addEntry()} />
          </div>
          <button className="btn primary" disabled={!add.name.trim()} onClick={addEntry}><UserPlus size={12} /> Add</button>
        </div>
      </Section>

      {LISTS.map((l) => (
        <Section key={l.id} title={`${l.label} · ${lists?.[l.id]?.length ?? 0}`} help={l.help}>
          {!lists ? <div className="group-row"><Spinner size={12} /></div> : lists[l.id].length === 0 ? (
            <div className="group-row muted">Empty</div>
          ) : (
            lists[l.id].map((e: any, i: number) => (
              <div key={i} className="group-row">
                <div className="row">
                  {e.uuid && <img className="mc-head" src={`https://mc-heads.net/avatar/${e.uuid}/24`} alt="" onError={(ev) => ((ev.target as HTMLImageElement).style.visibility = 'hidden')} />}
                  <b>{e.name ?? e.ip}</b>
                  {e.level && <span className="badge">level {e.level}</span>}
                  {e.reason && <span className="small muted">{e.reason}</span>}
                </div>
                <button className="btn" onClick={() => removeEntry(l.id, e)}>Remove</button>
              </div>
            ))
          )}
        </Section>
      ))}
    </div>
  )
}

// ===========================================================================
// Worlds
// ===========================================================================
// camel = up to 1.21.10, snake = 1.21.11 / 26.x and newer (names changed)
const GAMERULES: { camel?: string; snake?: string; type: 'bool' | 'int'; help: string }[] = [
  { camel: 'keepInventory', snake: 'keep_inventory', type: 'bool', help: 'Players keep items and XP when they die.' },
  { camel: 'doDaylightCycle', snake: 'advance_time', type: 'bool', help: 'Time of day advances.' },
  { camel: 'doWeatherCycle', snake: 'advance_weather', type: 'bool', help: 'Weather changes naturally.' },
  { camel: 'doMobSpawning', snake: 'spawn_mobs', type: 'bool', help: 'Mobs spawn naturally.' },
  { camel: 'mobGriefing', snake: 'mob_griefing', type: 'bool', help: 'Creepers, endermen etc. can change blocks.' },
  { camel: 'doFireTick', type: 'bool', help: 'Fire spreads and burns out.' },
  { snake: 'fire_spread_radius_around_player', type: 'int', help: 'Fire only spreads within this distance of a player (0 disables spread).' },
  { camel: 'doInsomnia', snake: 'spawn_phantoms', type: 'bool', help: 'Phantoms spawn for players who do not sleep.' },
  { camel: 'doImmediateRespawn', snake: 'immediate_respawn', type: 'bool', help: 'Skip the death screen.' },
  { camel: 'announceAdvancements', snake: 'show_advancement_messages', type: 'bool', help: 'Advancements are posted in chat.' },
  { camel: 'showDeathMessages', snake: 'show_death_messages', type: 'bool', help: 'Death messages in chat.' },
  { camel: 'naturalRegeneration', snake: 'natural_health_regeneration', type: 'bool', help: 'Health regenerates with full hunger.' },
  { camel: 'fallDamage', snake: 'fall_damage', type: 'bool', help: 'Players take fall damage.' },
  { camel: 'fireDamage', snake: 'fire_damage', type: 'bool', help: 'Players take fire damage.' },
  { camel: 'drowningDamage', snake: 'drowning_damage', type: 'bool', help: 'Players can drown.' },
  { camel: 'freezeDamage', snake: 'freeze_damage', type: 'bool', help: 'Powder snow damage.' },
  { camel: 'doTileDrops', snake: 'block_drops', type: 'bool', help: 'Blocks drop items when broken.' },
  { camel: 'doEntityDrops', snake: 'entity_drops', type: 'bool', help: 'Minecarts, item frames etc. drop items.' },
  { camel: 'doMobLoot', snake: 'mob_drops', type: 'bool', help: 'Mobs drop loot.' },
  { camel: 'doPatrolSpawning', snake: 'spawn_patrols', type: 'bool', help: 'Pillager patrols spawn.' },
  { camel: 'doTraderSpawning', snake: 'spawn_wandering_traders', type: 'bool', help: 'Wandering traders spawn.' },
  { camel: 'disableRaids', type: 'bool', help: 'Turn off raids.' },
  { snake: 'raids', type: 'bool', help: 'Raids can happen.' },
  { snake: 'tnt_explodes', type: 'bool', help: 'TNT explodes when ignited.' },
  { snake: 'spawner_blocks_work', type: 'bool', help: 'Monster spawner blocks spawn mobs.' },
  { snake: 'command_blocks_work', type: 'bool', help: 'Command blocks run commands.' },
  { snake: 'allow_entering_nether_using_portals', type: 'bool', help: 'Nether portals work.' },
  { snake: 'locator_bar', type: 'bool', help: 'Show the player locator bar.' },
  { camel: 'forgiveDeadPlayers', snake: 'forgive_dead_players', type: 'bool', help: 'Angry neutral mobs calm down when their target dies.' },
  { camel: 'universalAnger', snake: 'universal_anger', type: 'bool', help: 'Angered neutral mobs attack any nearby player.' },
  { snake: 'pvp', type: 'bool', help: 'Players can damage each other.' },
  { camel: 'commandBlockOutput', snake: 'command_block_output', type: 'bool', help: 'Command blocks post output in chat.' },
  { camel: 'sendCommandFeedback', snake: 'send_command_feedback', type: 'bool', help: 'Players see feedback from their commands.' },
  { camel: 'logAdminCommands', snake: 'log_admin_commands', type: 'bool', help: 'Admin commands are logged.' },
  { camel: 'reducedDebugInfo', snake: 'reduced_debug_info', type: 'bool', help: 'Hide coordinates in the F3 screen.' },
  { camel: 'spectatorsGenerateChunks', snake: 'spectators_generate_chunks', type: 'bool', help: 'Spectators load new terrain.' },
  { camel: 'randomTickSpeed', snake: 'random_tick_speed', type: 'int', help: 'How fast crops grow and leaves decay (default 3; 0 freezes growth).' },
  { camel: 'playersSleepingPercentage', snake: 'players_sleeping_percentage', type: 'int', help: 'Percentage of players that must sleep to skip the night (default 100).' },
  { camel: 'spawnRadius', snake: 'respawn_radius', type: 'int', help: 'Radius around world spawn where players respawn.' },
  { camel: 'maxEntityCramming', snake: 'max_entity_cramming', type: 'int', help: 'Entities in one block before suffocating (default 24).' },
  { camel: 'maxCommandChainLength', type: 'int', help: 'Command block chain limit.' },
  { camel: 'snowAccumulationHeight', type: 'int', help: 'Snow layers that build up during snowfall.' },
]

function snakeStyle(v: string) {
  const [a, b = 0, c = 0] = v.split(/[.-]/).map((x) => parseInt(x) || 0)
  return a >= 26 || (a === 1 && (b > 21 || (b === 21 && c >= 11)))
}

export function WorldsTab() {
  const { srv, task, setTab, reload } = useCtx()
  const [worlds, setWorlds] = useState<{ name: string; size: string }[] | null>(null)
  const [rules, setRules] = useState<Record<string, string>>({})
  const [rq, setRq] = useState('')
  const [loadingRules, setLoadingRules] = useState(false)
  const snake = snakeStyle(srv.config.mcVersion || '0')
  const ruleList = GAMERULES.map((g) => ({ ...g, name: snake ? g.snake : g.camel })).filter((g) => g.name) as (typeof GAMERULES[number] & { name: string })[]
  const canCmd = srv.running && srv.managed && !srv.external

  const load = async () => {
    const r = await run(srv.hostId, `cd ${shq(srv.dir)} && for d in */; do d=\${d%/}; [ -f "$d/level.dat" ] && echo "$d|$(du -sh "$d" 2>/dev/null | cut -f1)"; done`, 60000)
    setWorlds(r.stdout.split('\n').filter(Boolean).map((l) => { const [name, size] = l.split('|'); return { name, size } }))
  }
  useEffect(() => { load() }, [srv.dir]) // eslint-disable-line

  const setActive = async (name: string) => {
    const path = `${srv.dir}/server.properties`
    const t = await api.fs.readText(srv.hostId, path)
    await api.fs.writeText(srv.hostId, path, serializeProps(t, { 'level-name': name }))
    toast({ title: `“${name}” will load on the next start`, kind: 'success' })
    await reload()
  }

  const family = (name: string) => [name, `${name}_nether`, `${name}_the_end`]

  const reset = async (name: string, del = false) => {
    if (srv.running && name === srv.levelName) return toast({ title: 'Stop the server first', kind: 'error' })
    const ok = await confirm(
      del ? `Delete world “${name}”?` : `Reset world “${name}”?`,
      del ? 'The world folders are deleted permanently.' : 'The world, its nether and end are deleted. A new world is generated on the next start (using the seed in Settings). Make a backup first if unsure.',
      del ? 'Delete' : 'Reset',
      true,
    )
    if (!ok) return
    await task(`${del ? 'Deleting' : 'Resetting'} ${name}`, `cd ${shq(srv.dir)} && for w in ${family(name).map(shq).join(' ')}; do [ -d "$w" ] && rm -rf -- "$w" && echo "Removed $w"; done; true`)
    load()
  }

  const loadRules = async () => {
    setLoadingRules(true)
    try {
      for (const g of ruleList) await ctl(srv.hostId, srv.dir, 'cmd', `gamerule ${g.name}`)
      await new Promise((r) => setTimeout(r, 1500))
      const r = await run(srv.hostId, `tail -n 400 ${shq(srv.dir + '/' + MC_DIR + '/console.log')}`)
      const vals: Record<string, string> = {}
      // eslint-disable-next-line no-control-regex
      const text = r.stdout.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
      for (const m of text.matchAll(/Game ?rule (\w+) is currently set to:? (\S+)/gi)) vals[m[1]] = m[2]
      setRules(vals)
      if (!Object.keys(vals).length) toast({ title: 'Could not read game rules', body: 'This Minecraft version may use different rule names. You can still set them below.', kind: 'error' })
    } finally {
      setLoadingRules(false)
    }
  }

  const setRule = async (name: string, value: string) => {
    const r = await ctl(srv.hostId, srv.dir, 'cmd', `gamerule ${name} ${value}`)
    if (r.code !== 0) toast({ title: 'Failed', body: r.stdout, kind: 'error' })
    else setRules((x) => ({ ...x, [name]: value }))
  }

  const groupMain = (worlds ?? []).filter((w) => !/_nether$|_the_end$/.test(w.name))
  return (
    <div className="grow scroll pad" style={{ maxWidth: 900, width: '100%', margin: '0 auto' }}>
      <Section
        title="Worlds"
        help="Folders in the server directory that contain a level.dat. The active world is the one named in level-name. To use a world from your Mac (single-player save), upload its folder and set it active."
        right={
          <div className="row">
            <button className="btn" onClick={load}><RefreshCw size={12} /></button>
            <button className="btn" onClick={async () => { if (await api.fs.uploadDialog(srv.hostId, srv.dir)) load() }}><Upload size={12} /> Upload World…</button>
          </div>
        }
      >
        {worlds === null ? <div className="group-row"><Spinner size={12} /></div> : groupMain.length === 0 ? (
          <div className="group-row muted">No world yet. It is generated on the first start.</div>
        ) : groupMain.map((w) => {
          const dims = (worlds ?? []).filter((x) => family(w.name).includes(x.name))
          const active = w.name === srv.levelName
          return (
            <div key={w.name} className="group-row">
              <div className="row">
                <Globe2 size={18} style={{ color: active ? 'var(--green)' : 'var(--text-3)' }} />
                <div>
                  <div className="row" style={{ gap: 6 }}><b>{w.name}</b>{active && <span className="badge" style={{ color: 'var(--green)' }}>Active</span>}</div>
                  <div className="small muted">{dims.map((d) => `${d.name.replace(w.name, '') || 'overworld'} ${d.size}`).join(' · ')}</div>
                </div>
              </div>
              <div className="row">
                {!active && <button className="btn" onClick={() => setActive(w.name)}><Play size={11} /> Make Active</button>}
                <button className="btn" onClick={() => api.fs.download(srv.hostId, dims.map((d) => ({ path: `${srv.dir}/${d.name}`, isDir: true })))}><Download size={11} /> Download</button>
                <button className="btn" onClick={() => reset(w.name)}><RotateCcw size={11} /> Reset</button>
                {!active && <button className="tb-btn" title="Delete" onClick={() => reset(w.name, true)}><Trash2 size={13} /></button>}
              </div>
            </div>
          )
        })}
        <div className="group-row">
          <span className="muted small">New world generation options (seed, type, structures) are in Settings → server.properties → World.</span>
          <button className="btn" onClick={() => setTab('Settings')}>Open</button>
        </div>
      </Section>

      <Section
        title="Game rules"
        help="Game rules are stored in the world and can only be changed while the server runs. Newer Minecraft versions may rename some rules; use the custom field for those."
        right={<button className="btn" disabled={!canCmd || loadingRules} onClick={loadRules}>{loadingRules ? <Spinner size={11} /> : <RefreshCw size={11} />} Load Current Values</button>}
      >
        {!canCmd && <div className="group-row muted">Start the server to change game rules.</div>}
        <div className="group-row">
          <div className="search" style={{ width: 240 }}><Search size={13} /><input placeholder="Filter rules" value={rq} onChange={(e) => setRq(e.target.value)} /></div>
          <CustomRule disabled={!canCmd} onSet={setRule} />
        </div>
        {ruleList.filter((g) => !rq || g.name.toLowerCase().includes(rq.toLowerCase()) || g.help.toLowerCase().includes(rq.toLowerCase())).map((g) => (
          <Row key={g.name} label={<span className="mono">{g.name}</span>} sub={g.help}>
            {g.type === 'bool' ? (
              <select className="select" style={{ width: 110 }} disabled={!canCmd} value={rules[g.name] ?? ''} onChange={(e) => setRule(g.name, e.target.value)}>
                <option value="" disabled>{rules[g.name] ?? 'unknown'}</option>
                <option value="true">true</option>
                <option value="false">false</option>
              </select>
            ) : (
              <IntRule disabled={!canCmd} value={rules[g.name]} onSet={(v) => setRule(g.name, v)} />
            )}
          </Row>
        ))}
      </Section>
    </div>
  )
}

function IntRule({ value, onSet, disabled }: { value?: string; onSet: (v: string) => void; disabled: boolean }) {
  const [v, setV] = useState(value ?? '')
  useEffect(() => setV(value ?? ''), [value])
  return (
    <span className="row">
      <input className="input" type="number" style={{ width: 80 }} disabled={disabled} placeholder="?" value={v} onChange={(e) => setV(e.target.value)} />
      <button className="btn" disabled={disabled || v === '' || v === value} onClick={() => onSet(v)}>Set</button>
    </span>
  )
}

function CustomRule({ onSet, disabled }: { onSet: (n: string, v: string) => void; disabled: boolean }) {
  const [n, setN] = useState('')
  const [v, setV] = useState('')
  return (
    <span className="row">
      <input className="input mono" style={{ width: 160 }} placeholder="rule name" disabled={disabled} value={n} onChange={(e) => setN(e.target.value.trim())} />
      <input className="input mono" style={{ width: 80 }} placeholder="value" disabled={disabled} value={v} onChange={(e) => setV(e.target.value.trim())} />
      <button className="btn" disabled={disabled || !n || !v} onClick={() => onSet(n, v)}>Set</button>
    </span>
  )
}

// ===========================================================================
// Backups
// ===========================================================================
export function BackupsTab() {
  const { srv, task, setTab, reload } = useCtx()
  const [list, setList] = useState<{ file: string; size: number; time: number }[] | null>(null)
  const [log, setLog] = useState('')
  const dir = srv.config.backups.dir.startsWith('/') ? srv.config.backups.dir : `${srv.dir}/${srv.config.backups.dir || 'backups'}`

  const load = async () => {
    const r = await run(srv.hostId, `cd ${shq(dir)} 2>/dev/null && for f in *.tar.gz; do [ -f "$f" ] && echo "$f|$(stat -c '%s|%Y' "$f")"; done; echo '@@'; tail -n 30 ${shq(srv.dir + '/' + MC_DIR + '/backup.log')} 2>/dev/null`)
    const [files, lg] = r.stdout.split('@@')
    setList(files.split('\n').filter(Boolean).map((l) => { const [file, size, time] = l.split('|'); return { file, size: +size, time: +time * 1000 } }).sort((a, b) => b.time - a.time))
    setLog(lg?.trim() ?? '')
  }
  useEffect(() => { load() }, [srv.dir]) // eslint-disable-line

  const create = async (scope: 'worlds' | 'full') => {
    await task(`Backing up ${scope === 'full' ? 'the whole server' : 'worlds'}`, `sh ${shq(srv.dir + '/' + MC_DIR + '/backup.sh')} ${scope}`)
    load()
  }

  const restore = async (file: string) => {
    const full = file.startsWith('full-')
    const ok = await confirm(
      `Restore ${file}?`,
      `${srv.running ? 'The server will be stopped. ' : ''}The current ${full ? 'server files' : 'worlds'} are moved to .sshos/pre-restore-… first, so you can undo this.${srv.running ? ' The server is started again afterwards.' : ''}`,
      'Restore',
      true,
    )
    if (!ok) return
    const wasRunning = srv.running
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)
    const level = srv.levelName
    const script = `set -e
cd ${shq(srv.dir)}
${wasRunning ? `sh .sshos/ctl.sh stop 5` : ''}
SAVE=.sshos/pre-restore-${stamp}; mkdir -p "$SAVE"
${full
    ? `for f in * .[!.]*; do case "$f" in .sshos|${shq((srv.config.backups.dir || 'backups').split('/')[0])}|'*'|'.[!.]*') continue;; esac; [ -e "$f" ] && mv "$f" "$SAVE/"; done
tar xzf ${shq(dir + '/' + file)} --exclude=./.sshos`
    : `for w in ${((srv as any).worldPaths as string[] | undefined ?? [level, level + '_nether', level + '_the_end']).map(shq).join(' ')}; do [ -d "$w" ] && mv "$w" "$SAVE/"; done
tar xzf ${shq(dir + '/' + file)}`}
echo ${shq(`Restored ${file}.`)} "Previous files saved in $SAVE"
${wasRunning ? 'sh .sshos/ctl.sh start' : ''}`
    await task(`Restoring ${file}`, script)
    reload()
  }

  const del = async (file: string) => {
    if (!(await confirm(`Delete ${file}?`, undefined, 'Delete', true))) return
    await api.fs.remove(srv.hostId, [{ path: `${dir}/${file}`, isDir: false }])
    load()
  }

  if (!srv.managed) return <div className="empty">Set up management (button above) to use backups.</div>

  const total = (list ?? []).reduce((a, b) => a + b.size, 0)
  return (
    <div className="grow scroll pad" style={{ maxWidth: 900, width: '100%', margin: '0 auto' }}>
      <Section title="Back up now" help="Worlds: only world folders (fast, small). Full: everything including plugins and configs.">
        <Row label="Create a backup" sub={`Saved to ${dir}`}>
          <button className="btn" onClick={() => create('worlds')}><Archive size={12} /> Worlds</button>
          <button className="btn" onClick={() => create('full')}><Archive size={12} /> Full Server</button>
        </Row>
        <Row label="Schedule" sub={`${describeSchedule(srv.config.backups.schedule)} · keeps ${srv.config.backups.keep} · ${srv.config.backups.scope}`}>
          <button className="btn" onClick={() => setTab('Settings')}>Change…</button>
        </Row>
      </Section>
      <Section title={`Backups · ${list?.length ?? 0} · ${formatBytes(total, true)}`} right={<button className="btn" onClick={load}><RefreshCw size={12} /></button>}>
        {list === null ? <div className="group-row"><Spinner size={12} /></div> : list.length === 0 ? <div className="group-row muted">No backups yet.</div> : list.map((b) => (
          <div key={b.file} className="group-row">
            <div>
              <b className="mono" style={{ fontSize: 12 }}>{b.file}</b>
              <div className="small muted">{new Date(b.time).toLocaleString()} · {formatBytes(b.size)}</div>
            </div>
            <div className="row">
              <button className="btn" onClick={() => restore(b.file)}><RotateCcw size={11} /> Restore</button>
              <button className="btn" onClick={() => api.fs.download(srv.hostId, [{ path: `${dir}/${b.file}`, isDir: false }])}><Download size={11} /> Download</button>
              <button className="tb-btn" onClick={() => del(b.file)}><Trash2 size={13} /></button>
            </div>
          </div>
        ))}
      </Section>
      {log && (
        <Section title="Scheduled backup log">
          <pre className="output" style={{ margin: 0, background: 'transparent', padding: '10px 0' }}>{log}</pre>
        </Section>
      )}
    </div>
  )
}

// ===========================================================================
// Updates
// ===========================================================================
export function UpdatesTab() {
  const { srv, task, saveCfg, setTab, reload } = useCtx()
  const c = srv.config
  const sw = SOFTWARE[c.software]
  const [latest, setLatest] = useState<{ build: string; javaMin?: number } | null | 'error'>(null)
  const [versions, setVersions] = useState<McVersion[] | null>(null)
  const [target, setTarget] = useState('')
  const [contentRes, setContentRes] = useState<{ content: any[]; errors: string[] } | null>(null)
  const [log, setLog] = useState('')
  const [oldJars, setOldJars] = useState<string[]>([])
  const [python, setPython] = useState(true)

  const load = async () => {
    setLatest(null)
    if (sw.autoUpdate && c.mcVersion) resolveServerJar(c.software, c.mcVersion).then((d) => setLatest({ build: d.build, javaMin: d.javaMin })).catch(() => setLatest('error'))
    if (sw.autoUpdate) listVersions(c.software).then((v) => setVersions(v.filter((x) => x.stable))).catch(() => {})
    const r = await run(srv.hostId, `command -v python3 >/dev/null && echo PY; echo '@@'; tail -n 40 ${shq(srv.dir + '/' + MC_DIR + '/update.log')} 2>/dev/null; echo '@@'; ls -1t ${shq(srv.dir + '/' + MC_DIR + '/old-jars')} 2>/dev/null`)
    const [py, lg, jars] = r.stdout.split('@@')
    setPython(py.includes('PY'))
    setLog(lg.trim())
    setOldJars(jars.split('\n').map((s) => s.trim()).filter(Boolean))
  }
  useEffect(() => { load() }, [srv.dir, c.build, c.mcVersion]) // eslint-disable-line

  const upToDate = latest && latest !== 'error' && String(latest.build) === String(c.build)
  const py = `cd ${shq(srv.dir)} && python3 .sshos/update.py`

  const updateServer = async () => {
    const r = await task(`Updating ${sw.name}`, `${py} --server-only --no-restart`)
    await reload()
    if (r.code === 0 && srv.running && (await confirm('Restart now to apply the update?', 'Players get a 10-second warning.', 'Restart'))) await ctl(srv.hostId, srv.dir, 'restart', '10')
  }

  const checkContent = async () => {
    const r = await task('Checking plugins & mods', `${py} --dry-run --json --content-only`, { quiet: true })
    const m = r.output.match(/@@RESULT (.*)/)
    if (m) setContentRes(JSON.parse(m[1]))
  }

  const changeVersion = async () => {
    if (!target) return
    const need = await javaFor(target)
    const ok = await confirm(
      `Change to Minecraft ${target}?`,
      `A backup of your worlds is made first. Worlds are upgraded when opened and cannot be opened by older versions again. Plugins/mods must support ${target}. ${need ? `Requires Java ${need}+.` : ''}`,
      'Back Up & Change',
      true,
    )
    if (!ok) return
    try {
      const dl = await resolveServerJar(c.software, target)
      dl.fileName = safeFileName(dl.fileName, 'server.jar')
      const r = await task(
        `Switching to ${target}`,
        `set -e
cd ${shq(srv.dir)}
${srv.running ? 'sh .sshos/ctl.sh stop 10' : ''}
sh .sshos/backup.sh worlds
echo ${shq(`Downloading ${dl.fileName}…`)}
if command -v curl >/dev/null; then curl -fL -o ${shq(dl.fileName)} ${shq(dl.url)}; else wget -O ${shq(dl.fileName)} ${shq(dl.url)}; fi
mkdir -p .sshos/old-jars; [ ${shq(c.jar)} != ${shq(dl.fileName)} ] && [ -f ${shq(c.jar)} ] && mv ${shq(c.jar)} .sshos/old-jars/ || true
echo "Done. Start the server to upgrade the world."`,
      )
      if (r.code === 0) await saveCfg({ mcVersion: target, jar: dl.fileName, build: dl.build, paperFlags: dl.recommendedFlags?.join(' ') ?? c.paperFlags })
    } catch (e: any) {
      toast({ title: 'Version change failed', body: e.message, kind: 'error' })
    }
  }

  const rollback = async (jar: string) => {
    if (!(await confirm(`Use ${jar} again?`, 'The current jar is moved to old-jars. Restart the server afterwards.', 'Roll Back'))) return
    await run(srv.hostId, `cd ${shq(srv.dir)} && mv ${shq('.sshos/old-jars/' + jar)} . && { [ -f ${shq(c.jar)} ] && [ ${shq(c.jar)} != ${shq(jar)} ] && mv ${shq(c.jar)} .sshos/old-jars/ || true; }`)
    await saveCfg({ jar, build: jar.match(/-(\d+)\.jar$/)?.[1] ?? undefined })
    toast({ title: `Rolled back to ${jar}`, body: 'Restart to apply.', kind: 'success' })
  }

  if (!srv.managed) return <div className="empty">Set up management (button above) to use updates.</div>

  // lists are newest-first: only offer upgrades (downgrading corrupts worlds)
  const curIdx = (versions ?? []).findIndex((v) => v.id === c.mcVersion)
  const newer = curIdx < 0 ? (versions ?? []) : (versions ?? []).slice(0, curIdx)
  return (
    <div className="grow scroll pad" style={{ maxWidth: 900, width: '100%', margin: '0 auto' }}>
      {!python && <div className="card" style={{ color: 'var(--orange)', marginBottom: 14 }}>python3 is not installed on this machine. The updater needs it: <span className="mono">sudo apt install python3</span></div>}
      <Section title="Server software" help="Builds are bug and security fixes for the same Minecraft version: safe to install.">
        <Row label={`${sw.name} ${c.mcVersion}`} sub={c.build ? `Installed build ${c.build}` : 'Installed build unknown'}>
          {!sw.autoUpdate ? <span className="muted small">{sw.name} cannot be updated automatically</span> : latest === null ? <Spinner size={12} /> : latest === 'error' ? <span className="muted small">Could not check</span> : upToDate ? (
            <span className="badge" style={{ color: 'var(--green)' }}>Up to date</span>
          ) : (
            <>
              <span className="badge" style={{ color: 'var(--accent)' }}>Build {latest.build} available</span>
              <button className="btn primary" disabled={!python} onClick={updateServer}><ArrowUpCircle size={12} /> Update</button>
            </>
          )}
          <button className="btn" onClick={load}><RefreshCw size={12} /></button>
        </Row>
        {sw.autoUpdate && newer[0] && (
          <Row label={`Minecraft ${newer.find((v) => v.stable)?.id ?? newer[0].id} is available`} sub={`This server runs ${c.mcVersion}. Check that your plugins support the new version first (Content tab shows compatibility).`}>
            <button className="btn primary" onClick={() => setTarget(newer.find((v) => v.stable)?.id ?? newer[0].id)}>Select</button>
          </Row>
        )}
        {sw.autoUpdate && (
          <Row label="Change Minecraft version" help="Upgrading is one-way for worlds. A world backup is made automatically. Downgrading is not supported by Minecraft and will corrupt worlds.">
            <select className="select" style={{ width: 140 }} value={target} onChange={(e) => setTarget(e.target.value)}>
              <option value="">{newer.length ? 'Choose…' : 'Already latest'}</option>
              {newer.slice(0, 60).map((v) => <option key={v.id} value={v.id}>{v.id}</option>)}
            </select>
            <button className="btn" disabled={!target} onClick={changeVersion}>Change</button>
          </Row>
        )}
        {oldJars.length > 0 && (
          <Row label="Roll back" help="Previous server jars kept by the updater (the newest 3).">
            <select className="select" style={{ width: 260 }} value="" onChange={(e) => e.target.value && rollback(e.target.value)}>
              <option value="">Previous jars…</option>
              {oldJars.map((j) => <option key={j} value={j}>{j}</option>)}
            </select>
          </Row>
        )}
      </Section>

      <Section title="Plugins, mods & data packs" help="Compares installed files with Modrinth (by checksum) and anything installed from Hangar/SpigotMC.">
        <Row label="Check for updates" sub={contentRes ? `${contentRes.content.length} update${contentRes.content.length === 1 ? '' : 's'} available` : undefined}>
          <button className="btn" disabled={!python} onClick={checkContent}>Check</button>
          {contentRes && contentRes.content.length > 0 && (
            <button className="btn primary" onClick={async () => { await task('Updating content', `${py} --content-only --no-restart`); setContentRes(null) }}>Update All</button>
          )}
        </Row>
        {contentRes?.content.map((u, i) => (
          <div key={i} className="group-row small">
            <span className="mono">{u.name}</span>
            <span>→ <b>{u.version}</b> <span className="muted">({u.source})</span></span>
          </div>
        ))}
        {contentRes?.errors.map((e, i) => <div key={i} className="group-row small" style={{ color: 'var(--red)' }}>{e}</div>)}
      </Section>

      <Section title="Automatic updates" right={<button className="btn" onClick={() => setTab('Settings')}>Configure…</button>}>
        <Row label="Schedule"><span className="muted">{describeSchedule(c.updates.schedule)}</span></Row>
        <Row label="What"><span className="muted">{[c.updates.server && 'server software', c.updates.content && 'plugins/mods'].filter(Boolean).join(' + ') || 'nothing'}{c.updates.followLatest ? ' · follows new Minecraft versions' : ''}</span></Row>
        <Row label="Then"><span className="muted">{c.updates.restart === 'always' ? 'restart automatically' : 'apply at next restart'}</span></Row>
        <Row label="Run the automatic update now" help="Runs exactly what the schedule runs, including the restart policy.">
          <button className="btn" disabled={!python} onClick={async () => { await task('Running updater', `${py}`); reload() }}><Play size={11} /> Run</button>
        </Row>
      </Section>

      {log && (
        <Section title="Update log">
          <pre className="output" style={{ margin: 0, background: 'transparent', padding: '10px 0' }}>{log}</pre>
        </Section>
      )}
    </div>
  )
}

// ===========================================================================
// Help
// ===========================================================================
export function HelpTab() {
  const [q, setQ] = useState('')
  const [open, setOpen] = useState<string>('start')
  const list = useMemo(() => HELP.filter((a) => !q || (a.title + a.body.join(' ')).toLowerCase().includes(q.toLowerCase())), [q])
  return (
    <div className="split">
      <div className="sidebar" style={{ width: 230 }}>
        <div className="search" style={{ width: '100%', marginBottom: 8 }}><Search size={13} /><input placeholder="Search help" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        {list.map((a) => (
          <div key={a.id} className={`sb-item ${open === a.id ? 'active' : ''}`} onClick={() => setOpen(a.id)}>
            <span className="grow">{a.title}</span>
          </div>
        ))}
        <div className="sb-section">Links</div>
        {[
          ['PaperMC docs', 'https://docs.papermc.io/paper'],
          ['Minecraft Wiki: server.properties', 'https://minecraft.wiki/w/Server.properties'],
          ['Minecraft Wiki: game rules', 'https://minecraft.wiki/w/Game_rule'],
          ['Modrinth', 'https://modrinth.com/plugins'],
          ['Hangar', 'https://hangar.papermc.io'],
          ['SpigotMC resources', 'https://www.spigotmc.org/resources/'],
        ].map(([l, u]) => (
          <div key={u} className="sb-item" onClick={() => api.openExternal(u)}><span className="grow" style={{ color: 'var(--accent)' }}>{l}</span></div>
        ))}
      </div>
      <div className="grow scroll pad" style={{ maxWidth: 760 }}>
        {(list.find((a) => a.id === open) ?? list[0]) && (() => {
          const a = list.find((x) => x.id === open) ?? list[0]
          return (
            <div className="help-article">
              <h2>{a.title}</h2>
              {a.body.map((p, i) =>
                p.startsWith('$ ') ? <pre key={i} className="output card" style={{ margin: '6px 0' }}>{p.slice(2)}</pre>
                  : p.startsWith('• ') ? <div key={i} className="help-bullet">{p.slice(2)}</div>
                    : <p key={i}>{p}</p>,
              )}
            </div>
          )
        })()}
      </div>
    </div>
  )
}

