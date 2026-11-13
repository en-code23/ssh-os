import { compareMcVersions, SOFTWARE, type Software } from './apis'

export type Compat = { status: 'ok' | 'incompatible' | 'unknown'; reason?: string }

/** Does `version` satisfy a Fabric/semver-style range like ">=1.21 <1.22", "~1.21.4", "1.21.x", "*"? */
export function inRange(version: string, range: string | string[]): boolean {
  if (Array.isArray(range)) return range.some((r) => inRange(version, r))
  const r = range.trim()
  if (!r || r === '*') return true
  // "a || b"
  if (r.includes('||')) return r.split('||').some((p) => inRange(version, p))
  // space-separated comparators must all hold
  const parts = r.split(/\s+/).filter(Boolean)
  return parts.every((p) => {
    const m = p.match(/^(>=|<=|>|<|=|~|\^)?\s*v?([\w.*+-]+)$/)
    if (!m) return true
    const op = m[1] ?? ''
    let v = m[2].replace(/\+.*$/, '')
    if (/[x*]/i.test(v)) {
      // wildcard: 1.21.x -> same prefix
      const prefix = v.split('.').filter((x) => !/^[x*]$/i.test(x))
      const vv = version.split(/[.-]/)
      return prefix.every((x, i) => vv[i] === x)
    }
    const c = compareMcVersions(version, v)
    switch (op) {
      case '>=': return c >= 0
      case '<=': return c <= 0
      case '>': return c > 0
      case '<': return c < 0
      case '~': {
        // ~1.21.4 => >=1.21.4 <1.22 ; ~1.21 => >=1.21 <1.22
        const [maj, min] = v.split('.')
        return c >= 0 && compareMcVersions(version, `${maj}.${(parseInt(min) || 0) + 1}`) < 0
      }
      case '^': {
        const [maj] = v.split('.')
        return c >= 0 && compareMcVersions(version, `${(parseInt(maj) || 0) + 1}`) < 0
      }
      default:
        v = v.replace(/-.*$/, '')
        return compareMcVersions(version.replace(/-.*$/, ''), v) === 0
    }
  })
}

/** Bukkit plugin.yml `api-version` is the *minimum* server API: newer plugins won't load on older servers. */
export function checkApiVersion(apiVersion: string | undefined, mcVersion: string): Compat {
  if (!apiVersion) return { status: 'unknown', reason: 'Legacy plugin without api-version; it may misbehave on modern servers.' }
  const need = apiVersion.replace(/['"]/g, '').trim()
  if (!mcVersion) return { status: 'unknown' }
  if (compareMcVersions(mcVersion, need) < 0) return { status: 'incompatible', reason: `Needs Minecraft ${need} or newer (server runs ${mcVersion}).` }
  return { status: 'ok' }
}

/**
 * Compatibility of an installed/available add-on from what we know about it.
 * @param gameVersions versions the add-on version declares (Modrinth)
 * @param loaders loaders it declares (Modrinth), e.g. ["paper","spigot"] or ["fabric"]
 */
export function checkDeclared(
  { gameVersions, loaders, kind }: { gameVersions?: string[]; loaders?: string[]; kind: 'plugin' | 'mod' | 'datapack' | 'resourcepack' },
  mcVersion: string,
  software: Software,
): Compat {
  if (loaders?.length && (kind === 'plugin' || kind === 'mod')) {
    const ours = SOFTWARE[software]?.loaders ?? []
    if (ours.length && !loaders.some((l) => ours.includes(l))) {
      return { status: 'incompatible', reason: `Made for ${loaders.slice(0, 3).join(', ')}, but this server runs ${SOFTWARE[software]?.name ?? software}.` }
    }
  }
  if (gameVersions?.length && mcVersion) {
    if (!gameVersions.includes(mcVersion)) {
      const newest = [...gameVersions].sort((a, b) => compareMcVersions(b, a))[0]
      return { status: 'incompatible', reason: `Supports Minecraft ${summarize(gameVersions)}, not ${mcVersion}${newest && compareMcVersions(newest, mcVersion) < 0 ? ' (too old)' : ''}.` }
    }
    return { status: 'ok' }
  }
  return { status: 'unknown' }
}

/** "1.20.1 – 1.21.4" style summary of a long version list. */
export function summarize(versions: string[]): string {
  const rel = versions.filter((v) => !/[a-z]/i.test(v.replace(/^\d.*?-/, ''))).sort((a, b) => compareMcVersions(a, b))
  const list = rel.length ? rel : versions
  if (list.length <= 3) return list.join(', ')
  return `${list[0]} – ${list[list.length - 1]}`
}

/** Spigot "tested versions" are usually major.minor ("1.21") — match loosely. */
export function checkTested(tested: string[] | undefined, mcVersion: string): Compat {
  if (!tested?.length || !mcVersion) return { status: 'unknown' }
  const [a, b] = mcVersion.split('.')
  const mm = `${a}.${b ?? ''}`.replace(/\.$/, '')
  if (tested.some((t) => t === mcVersion || t === mm || t === a)) return { status: 'ok' }
  return { status: 'incompatible', reason: `Tested on ${summarize(tested)}, not ${mcVersion}.` }
}
