import type { Software } from './apis'

/** Player-count presets offered when creating a server. */
export const PLAYER_PRESETS = [
  { players: 5, label: '1–5', hint: 'Just me and a few friends' },
  { players: 10, label: '6–10', hint: 'A small group' },
  { players: 20, label: '11–20', hint: 'A community server' },
  { players: 50, label: '21–50', hint: 'A busy public server' },
  { players: 100, label: '51–100', hint: 'A large server (needs strong hardware)' },
] as const

export interface Tuning {
  players: number
  /** recommended max heap in MB (already capped to what the machine can spare) */
  xmxMb: number
  /** what the server would ideally want, before capping */
  idealMb: number
  viewDistance: number
  simulationDistance: number
  /** user-facing explanation lines */
  notes: string[]
  /** problems with the machine for this player count */
  warnings: string[]
}

/**
 * Size a Minecraft server for an expected number of players on a given machine.
 * Rules of thumb used by PaperMC/hosting providers:
 *  - Paper needs ~1.5 GB baseline plus ~100–150 MB per active player; mods roughly ×1.6.
 *  - view/simulation distance are the biggest CPU & RAM levers, so they shrink as players grow.
 *  - leave ~1.5 GB (≥ 25% on small machines) for the operating system.
 */
export function tune(players: number, software: Software, memTotalMb: number, cpus: number): Tuning {
  const modded = software === 'fabric' || software === 'forge' || software === 'neoforge'
  const vanillaish = software === 'vanilla'
  const perPlayer = modded ? 220 : vanillaish ? 160 : 120
  const base = modded ? 2560 : vanillaish ? 1792 : 1536
  let ideal = base + perPlayer * players
  ideal = Math.ceil(ideal / 512) * 512
  ideal = Math.min(ideal, modded ? 16384 : 12288) // beyond this G1 pauses grow without benefit

  const reserve = Math.max(1536, Math.round(memTotalMb * 0.25))
  const spare = Math.max(512, memTotalMb - reserve)
  const xmxMb = Math.max(1024, Math.min(ideal, Math.floor(spare / 256) * 256))

  // distances by player count
  let view = players <= 5 ? 10 : players <= 10 ? 9 : players <= 20 ? 8 : players <= 50 ? 7 : 6
  let sim = players <= 5 ? 10 : players <= 10 ? 8 : players <= 20 ? 6 : players <= 50 ? 5 : 4

  const notes: string[] = []
  const warnings: string[] = []
  const short = xmxMb < ideal
  if (short) {
    // not enough RAM for the ideal setup: trade view distance for memory
    const ratio = xmxMb / ideal
    if (ratio < 0.8) view = Math.max(5, view - 2)
    else view = Math.max(5, view - 1)
    if (ratio < 0.8) sim = Math.max(4, sim - 1)
    warnings.push(
      `This machine can give the server about ${(xmxMb / 1024).toFixed(1)} GB, but ${players} players ideally need ${(ideal / 1024).toFixed(1)} GB. View distance was reduced to compensate; expect lag at peak times.`,
    )
  }
  if (cpus < 2 && players > 5) warnings.push('Only 1 CPU core: Minecraft runs the world on one main thread, but the OS, networking and saving also need CPU. More than ~5 players will likely lag.')
  else if (cpus < 4 && players > 20) warnings.push(`${cpus} CPU cores is tight for ${players} players. Consider a lower simulation distance or a stronger machine.`)
  if (software === 'vanilla' && players > 10) warnings.push('Vanilla is much slower than Paper with many players. Paper is recommended for 10+ players.')
  if (software === 'folia' && players < 50) notes.push('Folia only pays off on very large servers; Paper is simpler for this size.')

  notes.push(`Memory: ${(xmxMb / 1024).toFixed(1)} GB (${(base / 1024).toFixed(1)} GB base + about ${perPlayer} MB per player${modded ? ', extra for mods' : ''}).`)
  notes.push(`View distance ${view}, simulation distance ${sim}: what players see vs. where mobs, farms and redstone keep running.`)
  return { players, xmxMb, idealMb: ideal, viewDistance: view, simulationDistance: sim, notes, warnings }
}
