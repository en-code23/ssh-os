export type PropType = 'bool' | 'int' | 'string' | 'enum' | 'text'

export interface PropDef {
  key: string
  label: string
  type: PropType
  group: string
  def: string
  help: string
  options?: { value: string; label: string }[]
  min?: number
  max?: number
  unit?: string
  restart?: boolean
}

const GM = [
  { value: 'survival', label: 'Survival' },
  { value: 'creative', label: 'Creative' },
  { value: 'adventure', label: 'Adventure' },
  { value: 'spectator', label: 'Spectator' },
]

export const PROP_GROUPS = ['General', 'Gameplay', 'World', 'Players & Access', 'Network', 'Performance', 'Resource Pack', 'RCON & Query', 'Advanced'] as const

export const PROPS: PropDef[] = [
  // General
  { key: 'motd', label: 'Message of the day', type: 'string', group: 'General', def: 'A Minecraft Server', help: 'The text shown under your server name in the multiplayer list. Supports § color codes (e.g. §aGreen) and \\n for a second line.' },
  { key: 'max-players', label: 'Max players', type: 'int', group: 'General', def: '20', min: 1, max: 1000, help: 'How many players can be online at the same time. Ops can bypass this only if their op entry allows it.' },
  { key: 'server-port', label: 'Server port', type: 'int', group: 'General', def: '25565', min: 1, max: 65535, restart: true, help: 'TCP port players connect to. 25565 is the default, so players can omit it. If you run several servers on one machine each needs its own port. Remember to open/forward this port in your firewall and router.' },
  { key: 'enable-status', label: 'Show in server list', type: 'bool', group: 'General', def: 'true', help: 'If off, the server appears offline in the multiplayer list (players can still join if they know the address).' },
  { key: 'hide-online-players', label: 'Hide online player list', type: 'bool', group: 'General', def: 'false', help: 'Hides the sample of player names shown when hovering the player count in the server list.' },

  // Gameplay
  { key: 'gamemode', label: 'Default game mode', type: 'enum', group: 'Gameplay', def: 'survival', options: GM, help: 'Game mode for new players. Existing players keep their current mode unless "Force game mode" is on.' },
  { key: 'force-gamemode', label: 'Force game mode', type: 'bool', group: 'Gameplay', def: 'false', help: 'Puts every player into the default game mode each time they join.' },
  { key: 'difficulty', label: 'Difficulty', type: 'enum', group: 'Gameplay', def: 'easy', options: ['peaceful', 'easy', 'normal', 'hard'].map((v) => ({ value: v, label: v[0].toUpperCase() + v.slice(1) })), help: 'Peaceful has no hostile mobs and no hunger. Hard makes mobs deal more damage and lets hunger kill you.' },
  { key: 'hardcore', label: 'Hardcore', type: 'bool', group: 'Gameplay', def: 'false', help: 'Locks difficulty to hard and puts players into spectator mode when they die. Cannot be undone for players who died.' },
  { key: 'pvp', label: 'PvP', type: 'bool', group: 'Gameplay', def: 'true', help: 'Whether players can damage each other directly. (Newer versions also expose this as a game rule.)' },
  { key: 'allow-flight', label: 'Allow flight', type: 'bool', group: 'Gameplay', def: 'false', help: 'Stops the server kicking survival players for "flying". Turn on if you use plugins/mods that grant flight (e.g. jetpacks), or players get kicked by the anti-cheat.' },
  { key: 'spawn-protection', label: 'Spawn protection radius', type: 'int', group: 'Gameplay', def: '16', min: 0, max: 1000, unit: 'blocks', help: 'Non-op players cannot build within this radius of the world spawn. 0 disables it. Has no effect when there are no ops.' },
  { key: 'player-idle-timeout', label: 'Idle kick time', type: 'int', group: 'Gameplay', def: '0', min: 0, max: 1440, unit: 'min', help: 'Kick players after this many minutes of inactivity. 0 = never.' },
  { key: 'allow-nether', label: 'Allow Nether', type: 'bool', group: 'Gameplay', def: 'true', help: 'If off, Nether portals do not work.' },
  { key: 'spawn-monsters', label: 'Spawn monsters', type: 'bool', group: 'Gameplay', def: 'true', help: 'Whether hostile mobs spawn naturally (removed in newer versions in favor of the doMobSpawning game rule).' },
  { key: 'spawn-animals', label: 'Spawn animals', type: 'bool', group: 'Gameplay', def: 'true', help: 'Whether passive animals spawn (older versions only).' },
  { key: 'spawn-npcs', label: 'Spawn villagers', type: 'bool', group: 'Gameplay', def: 'true', help: 'Whether villagers spawn (older versions only).' },
  { key: 'enable-command-block', label: 'Command blocks', type: 'bool', group: 'Gameplay', def: 'false', help: 'Allow command blocks to run. Needed for many adventure maps.' },

  // World
  { key: 'level-name', label: 'World folder', type: 'string', group: 'World', def: 'world', restart: true, help: 'Name of the world folder to load. Change it to switch worlds; a new world is generated if the folder does not exist. Nether and End use <name>_nether and <name>_the_end on Paper/Spigot.' },
  { key: 'level-seed', label: 'Seed', type: 'string', group: 'World', def: '', restart: true, help: 'Seed used when a NEW world is generated. Leave empty for a random seed. Changing it does not affect an existing world.' },
  { key: 'level-type', label: 'World type', type: 'enum', group: 'World', def: 'minecraft:normal', restart: true, options: [
    { value: 'minecraft:normal', label: 'Normal' }, { value: 'minecraft:flat', label: 'Superflat' }, { value: 'minecraft:large_biomes', label: 'Large biomes' },
    { value: 'minecraft:amplified', label: 'Amplified' }, { value: 'minecraft:single_biome_surface', label: 'Single biome' },
  ], help: 'Terrain generator for NEW worlds. Amplified needs a lot more CPU and RAM.' },
  { key: 'generator-settings', label: 'Generator settings (JSON)', type: 'text', group: 'World', def: '{}', restart: true, help: 'Advanced JSON options for the world generator, e.g. superflat layers. Leave {} unless you know what you need.' },
  { key: 'generate-structures', label: 'Generate structures', type: 'bool', group: 'World', def: 'true', restart: true, help: 'Villages, temples, strongholds etc. in newly generated chunks.' },
  { key: 'max-world-size', label: 'Max world radius', type: 'int', group: 'World', def: '29999984', min: 1, max: 29999984, unit: 'blocks', help: 'Sets the maximum world border radius. Useful to limit disk usage. Prefer /worldborder for finer control.' },
  { key: 'initial-enabled-packs', label: 'Enabled data packs (new worlds)', type: 'string', group: 'World', def: 'vanilla', help: 'Comma-separated data packs enabled when a world is first created, e.g. vanilla,update_1_21.' },
  { key: 'initial-disabled-packs', label: 'Disabled data packs (new worlds)', type: 'string', group: 'World', def: '', help: 'Comma-separated data packs to disable when a world is first created.' },

  // Players
  { key: 'online-mode', label: 'Online mode (verify accounts)', type: 'bool', group: 'Players & Access', def: 'true', restart: true, help: 'Checks every player against Mojang/Microsoft accounts. Keep this ON: turning it off lets anyone join with any name (including yours) unless you run a proxy like Velocity that does authentication.' },
  { key: 'white-list', label: 'Whitelist', type: 'bool', group: 'Players & Access', def: 'false', help: 'Only players on the whitelist (and ops) can join. Manage the list in the Players tab.' },
  { key: 'enforce-whitelist', label: 'Enforce whitelist', type: 'bool', group: 'Players & Access', def: 'false', help: 'Kicks online players who are not whitelisted when the whitelist is reloaded or enabled.' },
  { key: 'op-permission-level', label: 'Op permission level', type: 'enum', group: 'Players & Access', def: '4', options: [
    { value: '1', label: '1 – bypass spawn protection' }, { value: '2', label: '2 – cheat commands, command blocks' },
    { value: '3', label: '3 – player management (kick, ban, op)' }, { value: '4', label: '4 – everything incl. /stop' },
  ], help: 'Default permission level given by /op.' },
  { key: 'function-permission-level', label: 'Function permission level', type: 'int', group: 'Players & Access', def: '2', min: 1, max: 4, help: 'Permission level of data pack functions.' },
  { key: 'enforce-secure-profile', label: 'Require signed chat', type: 'bool', group: 'Players & Access', def: 'true', help: 'Requires players to have a Mojang-signed public key for chat. Turn off if players with modified clients cannot chat, or when using some proxies.' },
  { key: 'prevent-proxy-connections', label: 'Block VPN/proxy logins', type: 'bool', group: 'Players & Access', def: 'false', help: 'Kicks players whose IP differs from the one Mojang saw during authentication (often blocks VPN users).' },
  { key: 'broadcast-console-to-ops', label: 'Show console output to ops', type: 'bool', group: 'Players & Access', def: 'true', help: 'Sends console command output to online ops.' },
  { key: 'broadcast-rcon-to-ops', label: 'Show RCON output to ops', type: 'bool', group: 'Players & Access', def: 'true', help: 'Sends RCON command output to online ops.' },
  { key: 'log-ips', label: 'Log player IPs', type: 'bool', group: 'Players & Access', def: 'true', help: 'Whether player IP addresses are written to the logs.' },

  // Network
  { key: 'server-ip', label: 'Bind address', type: 'string', group: 'Network', def: '', restart: true, help: 'Leave EMPTY to listen on all interfaces (normal). Only set this to bind to one specific IP of the machine. This is NOT where players connect to.' },
  { key: 'network-compression-threshold', label: 'Compression threshold', type: 'int', group: 'Network', def: '256', min: -1, max: 65535, unit: 'bytes', help: 'Packets bigger than this are compressed. -1 disables compression (good behind a proxy on the same machine); higher values use less CPU but more bandwidth.' },
  { key: 'rate-limit', label: 'Packet rate limit', type: 'int', group: 'Network', def: '0', min: 0, max: 100000, unit: 'pkt/s', help: 'Kick players sending more packets per second than this. 0 = no limit.' },
  { key: 'use-native-transport', label: 'Native networking (Linux epoll)', type: 'bool', group: 'Network', def: 'true', help: 'Use Linux optimized networking. Leave on.' },
  { key: 'accepts-transfers', label: 'Accept transfers', type: 'bool', group: 'Network', def: 'false', help: 'Allow players to be transferred here from another server using /transfer (1.20.5+).' },
  { key: 'bug-report-link', label: 'Bug report link', type: 'string', group: 'Network', def: '', help: 'URL shown on the disconnect screen to report server bugs (1.21+).' },

  // Performance
  { key: 'view-distance', label: 'View distance', type: 'int', group: 'Performance', def: '10', min: 3, max: 32, unit: 'chunks', help: 'How many chunks around each player are sent and kept loaded. The biggest single factor for RAM/CPU. 6–8 is a good value for small machines like a Raspberry Pi; 10–12 for strong servers.' },
  { key: 'simulation-distance', label: 'Simulation distance', type: 'int', group: 'Performance', def: '10', min: 3, max: 32, unit: 'chunks', help: 'Within this many chunks of a player, mobs move, crops grow and redstone runs. Lowering it saves lots of CPU; keep it ≤ view distance.' },
  { key: 'entity-broadcast-range-percentage', label: 'Entity visibility range', type: 'int', group: 'Performance', def: '100', min: 10, max: 1000, unit: '%', help: 'How far entities are visible, relative to the default. Lower = less network traffic.' },
  { key: 'max-tick-time', label: 'Watchdog timeout', type: 'int', group: 'Performance', def: '60000', min: -1, max: 600000, unit: 'ms', help: 'If one tick takes longer than this, the server is considered frozen and is shut down. -1 disables the watchdog (useful while pre-generating worlds).' },
  { key: 'sync-chunk-writes', label: 'Synchronous chunk writes', type: 'bool', group: 'Performance', def: 'true', help: 'Safer saving at the cost of performance. Paper turns this off by default; on slow SD cards keep it on to avoid corruption.' },
  { key: 'max-chained-neighbor-updates', label: 'Max chained block updates', type: 'int', group: 'Performance', def: '1000000', min: -1, max: 100000000, help: 'Limit for consecutive neighbor updates before they are skipped. Protects against lag machines.' },
  { key: 'region-file-compression', label: 'Region file compression', type: 'enum', group: 'Performance', def: 'deflate', options: [{ value: 'deflate', label: 'Deflate (default)' }, { value: 'lz4', label: 'LZ4 (faster, bigger)' }, { value: 'none', label: 'None' }], help: 'How world chunks are compressed on disk (1.20.5+).' },
  { key: 'pause-when-empty-seconds', label: 'Pause when empty after', type: 'int', group: 'Performance', def: '60', min: -1, max: 86400, unit: 's', help: 'Stops ticking the world when no players are online for this long (1.21.2+). Saves CPU on idle servers. -1 disables.' },

  // Resource pack
  { key: 'resource-pack', label: 'Resource pack URL', type: 'string', group: 'Resource Pack', def: '', help: 'Direct download URL of a .zip resource pack players are offered on join. Install one from the Content tab to fill this automatically.' },
  { key: 'resource-pack-sha1', label: 'Resource pack SHA-1', type: 'string', group: 'Resource Pack', def: '', help: 'SHA-1 checksum of the pack, so clients can cache it and detect changes. Filled automatically when installed from Modrinth.' },
  { key: 'resource-pack-id', label: 'Resource pack UUID', type: 'string', group: 'Resource Pack', def: '', help: 'Optional UUID that identifies the pack on clients (1.20.3+).' },
  { key: 'require-resource-pack', label: 'Require resource pack', type: 'bool', group: 'Resource Pack', def: 'false', help: 'Players who decline the pack are kicked.' },
  { key: 'resource-pack-prompt', label: 'Resource pack prompt', type: 'string', group: 'Resource Pack', def: '', help: 'Custom message shown when asking players to download the pack (JSON text or plain).' },

  // RCON & Query
  { key: 'enable-rcon', label: 'Enable RCON', type: 'bool', group: 'RCON & Query', def: 'false', restart: true, help: 'Remote console protocol for external tools. Not needed by SSH OS. If enabled, use a long random password and do NOT expose the port to the internet: RCON is unencrypted.' },
  { key: 'rcon.port', label: 'RCON port', type: 'int', group: 'RCON & Query', def: '25575', min: 1, max: 65535, restart: true, help: 'TCP port for RCON.' },
  { key: 'rcon.password', label: 'RCON password', type: 'string', group: 'RCON & Query', def: '', restart: true, help: 'Password for RCON. Required if RCON is enabled.' },
  { key: 'enable-query', label: 'Enable GameSpy4 query', type: 'bool', group: 'RCON & Query', def: 'false', restart: true, help: 'Lets server-list websites query player counts and plugins over UDP.' },
  { key: 'query.port', label: 'Query port', type: 'int', group: 'RCON & Query', def: '25565', min: 1, max: 65535, restart: true, help: 'UDP port for the query protocol.' },

  // Advanced
  { key: 'enable-jmx-monitoring', label: 'JMX monitoring', type: 'bool', group: 'Advanced', def: 'false', help: 'Exposes tick-time MBeans for Java monitoring tools.' },
  { key: 'text-filtering-config', label: 'Text filtering config', type: 'string', group: 'Advanced', def: '', help: 'Used by Realms; leave empty.' },
  { key: 'text-filtering-version', label: 'Text filtering version', type: 'int', group: 'Advanced', def: '0', min: 0, max: 1, help: 'Used by Realms; leave 0.' },
  { key: 'debug', label: 'Debug', type: 'bool', group: 'Advanced', def: 'false', help: 'Extra debug logging.' },
  { key: 'snooper-enabled', label: 'Snooper', type: 'bool', group: 'Advanced', def: 'true', help: 'Sent anonymous usage data to Mojang (removed in 1.18).' },
]

export const PROP_BY_KEY = Object.fromEntries(PROPS.map((p) => [p.key, p]))

/** Parse server.properties, preserving lines so we can write it back faithfully. */
export function parseProps(text: string) {
  const lines = text.split('\n')
  const values: Record<string, string> = {}
  for (const l of lines) {
    if (!l.trim() || /^\s*[#!]/.test(l)) continue
    const i = l.search(/[=:]/)
    if (i < 0) continue
    values[l.slice(0, i).trim()] = unescapeProp(l.slice(i + 1).trimStart().replace(/\r$/, ''))
  }
  return { lines, values }
}

function unescapeProp(v: string) {
  return v.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_, c: string) =>
    c.length === 5 ? String.fromCharCode(parseInt(c.slice(1), 16)) : c === 'n' ? '\n' : c === 't' ? '\t' : c,
  )
}

function escapeProp(v: string) {
  return v.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/[^\x20-\x7e]/g, (ch) => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'))
}

export function serializeProps(original: string, values: Record<string, string>) {
  const { lines } = parseProps(original)
  const seen = new Set<string>()
  const out = lines.map((l) => {
    if (!l.trim() || /^\s*[#!]/.test(l)) return l
    const i = l.search(/[=:]/)
    if (i < 0) return l
    const k = l.slice(0, i).trim()
    seen.add(k)
    if (!(k in values)) return l
    return `${k}=${escapeProp(values[k])}`
  })
  for (const [k, v] of Object.entries(values)) if (!seen.has(k)) out.push(`${k}=${escapeProp(v)}`)
  return out.join('\n').replace(/\n*$/, '\n')
}
