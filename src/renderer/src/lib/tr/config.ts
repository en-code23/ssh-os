import type { PropDef } from '../mc/properties'
import type { TrSoftware } from './server'

const yesNo = (def: string) => ({ type: 'enum' as const, def, options: [{ value: '1', label: 'On' }, { value: '0', label: 'Off' }] })
const journey = [
  { value: '0', label: 'Nobody' },
  { value: '1', label: 'Host only' },
  { value: '2', label: 'Everyone' },
]

export const TR_GROUPS = ['World', 'Players & Access', 'Network', 'Journey Mode', 'Advanced'] as const

/** serverconfig.txt keys (Terraria 1.4 / TShock / tModLoader). */
export const TR_PROPS: PropDef[] = [
  { key: 'world', label: 'World file', type: 'string', group: 'World', def: '', restart: true, help: 'Full path of the .wld world file to load. Pick a world in the Worlds tab instead of typing this.' },
  { key: 'autocreate', label: 'Create world if missing', type: 'enum', group: 'World', def: '2', restart: true, options: [{ value: '1', label: 'Small' }, { value: '2', label: 'Medium' }, { value: '3', label: 'Large' }, { value: '', label: 'Never' }], help: 'If the world file does not exist, generate a new world of this size. Small fits ~1–4 players, Medium ~4–8, Large 8+. Larger worlds use more RAM and take longer to save.' },
  { key: 'worldname', label: 'World name', type: 'string', group: 'World', def: 'Terraria', restart: true, help: 'Name of a newly generated world (shown to players).' },
  { key: 'seed', label: 'Seed', type: 'string', group: 'World', def: '', restart: true, help: 'Seed for a NEW world. Empty = random. Secret seeds like "for the worthy" or "not the bees" work too.' },
  { key: 'difficulty', label: 'Difficulty (new worlds)', type: 'enum', group: 'World', def: '0', restart: true, options: [{ value: '0', label: 'Classic' }, { value: '1', label: 'Expert' }, { value: '2', label: 'Master' }, { value: '3', label: 'Journey' }], help: 'Difficulty of a newly generated world. Existing worlds keep their difficulty.' },
  { key: 'worldpath', label: 'Worlds folder', type: 'string', group: 'World', def: '', restart: true, help: 'Folder where world files are stored. SSH OS uses the worlds/ folder of the server.' },
  { key: 'maxplayers', label: 'Max players', type: 'int', group: 'Players & Access', def: '8', min: 1, max: 255, restart: true, help: 'Maximum number of players at the same time (1–255). Terraria is lightweight; 8–16 is typical.' },
  { key: 'password', label: 'Server password', type: 'string', group: 'Players & Access', def: '', restart: true, help: 'Players must enter this password to join. Leave empty for an open server.' },
  { key: 'motd', label: 'Message of the day', type: 'string', group: 'Players & Access', def: '', help: 'Shown to players when they join.' },
  { key: 'banlist', label: 'Ban list file', type: 'string', group: 'Players & Access', def: 'banlist.txt', help: 'File with banned players (vanilla servers; TShock stores bans in its database).' },
  { key: 'secure', label: 'Cheat protection', ...yesNo('1'), group: 'Players & Access', restart: true, help: 'Extra checks against modified clients. Leave on for public servers.' },
  { key: 'port', label: 'Port', type: 'int', group: 'Network', def: '7777', min: 1, max: 65535, restart: true, help: 'TCP port players connect to (default 7777). Forward it on your router for players outside your network. Each server on the machine needs its own port.' },
  { key: 'upnp', label: 'Automatic port forwarding (UPnP)', ...yesNo('0'), group: 'Network', restart: true, help: 'Ask your router to forward the port automatically. Many routers have UPnP off; manual forwarding is more reliable.' },
  { key: 'npcstream', label: 'NPC stream', type: 'int', group: 'Network', def: '60', min: 0, max: 600, help: 'Reduces enemy skipping/teleporting by sending NPC updates more often. Higher = more bandwidth. 0 disables. 60 is a good default.' },
  { key: 'language', label: 'Language', type: 'enum', group: 'Advanced', def: 'en-US', options: ['en-US', 'de-DE', 'it-IT', 'fr-FR', 'es-ES', 'ru-RU', 'zh-Hans', 'pt-BR', 'pl-PL'].map((v) => ({ value: v, label: v })), help: 'Server language for messages.' },
  { key: 'priority', label: 'Process priority', type: 'enum', group: 'Advanced', def: '1', options: [{ value: '0', label: 'Realtime' }, { value: '1', label: 'High' }, { value: '2', label: 'Above normal' }, { value: '3', label: 'Normal' }, { value: '4', label: 'Below normal' }, { value: '5', label: 'Idle' }], help: 'Process priority (Windows only; ignored on Linux).' },
  { key: 'journeypermission_time_setfrozen', label: 'Freeze time', type: 'enum', group: 'Journey Mode', def: '2', options: journey, help: 'Who can freeze the time of day in Journey mode.' },
  { key: 'journeypermission_time_setdawn', label: 'Set time to dawn', type: 'enum', group: 'Journey Mode', def: '2', options: journey, help: 'Who can jump time to dawn.' },
  { key: 'journeypermission_time_setnoon', label: 'Set time to noon', type: 'enum', group: 'Journey Mode', def: '2', options: journey, help: 'Who can jump time to noon.' },
  { key: 'journeypermission_time_setdusk', label: 'Set time to dusk', type: 'enum', group: 'Journey Mode', def: '2', options: journey, help: 'Who can jump time to dusk.' },
  { key: 'journeypermission_time_setmidnight', label: 'Set time to midnight', type: 'enum', group: 'Journey Mode', def: '2', options: journey, help: 'Who can jump time to midnight.' },
  { key: 'journeypermission_godmode', label: 'God mode', type: 'enum', group: 'Journey Mode', def: '2', options: journey, help: 'Who can toggle invincibility.' },
  { key: 'journeypermission_wind_setstrength', label: 'Wind strength', type: 'enum', group: 'Journey Mode', def: '2', options: journey, help: 'Who can change the wind.' },
  { key: 'journeypermission_rain_setstrength', label: 'Rain strength', type: 'enum', group: 'Journey Mode', def: '2', options: journey, help: 'Who can change the rain.' },
  { key: 'journeypermission_time_setspeed', label: 'Time speed', type: 'enum', group: 'Journey Mode', def: '2', options: journey, help: 'Who can speed up time.' },
  { key: 'journeypermission_rain_setfrozen', label: 'Freeze rain', type: 'enum', group: 'Journey Mode', def: '2', options: journey, help: 'Who can freeze the rain.' },
  { key: 'journeypermission_wind_setfrozen', label: 'Freeze wind', type: 'enum', group: 'Journey Mode', def: '2', options: journey, help: 'Who can freeze the wind.' },
  { key: 'journeypermission_increaseplacementrange', label: 'Placement range', type: 'enum', group: 'Journey Mode', def: '2', options: journey, help: 'Who can increase their block placement range.' },
  { key: 'journeypermission_setdifficulty', label: 'Enemy difficulty slider', type: 'enum', group: 'Journey Mode', def: '2', options: journey, help: 'Who can change enemy difficulty.' },
  { key: 'journeypermission_biomespread_setfrozen', label: 'Freeze biome spread', type: 'enum', group: 'Journey Mode', def: '2', options: journey, help: 'Who can stop corruption/crimson/hallow spreading.' },
  { key: 'journeypermission_setspawnrate', label: 'Spawn rate', type: 'enum', group: 'Journey Mode', def: '2', options: journey, help: 'Who can change enemy spawn rates.' },
]

export const TR_PRESETS = [
  { players: 4, label: '1–4', hint: 'Me and a couple of friends', size: '1' },
  { players: 8, label: '5–8', hint: 'A small group (Terraria default)', size: '2' },
  { players: 16, label: '9–16', hint: 'A community server', size: '2' },
  { players: 32, label: '17–32', hint: 'A busy server', size: '3' },
  { players: 64, label: '33–64', hint: 'A large public server', size: '3' },
] as const

export interface TrTuning {
  maxPlayers: number
  worldSize: '1' | '2' | '3'
  npcstream: number
  needMb: number
  notes: string[]
  warnings: string[]
}

/** Size a Terraria server for a player count on a machine. */
export function tuneTr(players: number, sw: TrSoftware, memTotalMb: number, cpus: number): TrTuning {
  const worldSize: TrTuning['worldSize'] = players <= 4 ? '1' : players <= 16 ? '2' : '3'
  const base = sw === 'tmodloader' ? 1536 : sw === 'tshock' ? 512 : 384
  const perPlayer = sw === 'tmodloader' ? 64 : 24
  const worldMb = worldSize === '1' ? 150 : worldSize === '2' ? 300 : 600
  const needMb = base + worldMb + perPlayer * players
  const npcstream = players > 32 ? 30 : 60 // less NPC traffic per player on big servers
  const notes = [
    `World size: ${worldSize === '1' ? 'Small' : worldSize === '2' ? 'Medium' : 'Large'} (enough room for ${players} players).`,
    `Expected memory use: about ${(needMb / 1024).toFixed(1)} GB${sw === 'tmodloader' ? ' plus whatever your mods need (big mods like Calamity add 1–2 GB)' : ''}.`,
  ]
  const warnings: string[] = []
  const spare = memTotalMb - 768
  if (needMb > spare) warnings.push(`This machine has ${(memTotalMb / 1024).toFixed(1)} GB; ${players} players on a ${worldSize === '3' ? 'large' : 'medium'} world may run out of memory. Pick a smaller world or fewer players.`)
  if (cpus < 2 && players > 8) warnings.push('One CPU core: expect lag with more than ~8 players.')
  if (players > 255) warnings.push('Terraria allows at most 255 players.')
  return { maxPlayers: Math.min(255, players), worldSize, npcstream, needMb, notes, warnings }
}
