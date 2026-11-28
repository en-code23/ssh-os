/**
 * Bedrock players on Java servers: Geyser translates the Bedrock protocol and Floodgate lets
 * Bedrock players join without a Java account. Floodgate gives every Bedrock player a fixed
 * UUID made from their Xbox user ID (XUID) and a name prefix (default ".").
 */
import { api, shq } from '../api'
import { run, type McServer } from './server'
import type { Software } from './apis'

export const isBedrockUuid = (uuid?: string) => !!uuid && /^00000000-0000-0000-/i.test(uuid)

/** Floodgate UUID for an XUID: new UUID(0, xuid) */
export function floodgateUuid(xuid: string | number) {
  const hex = BigInt(xuid).toString(16).padStart(16, '0')
  return `00000000-0000-0000-${hex.slice(0, 4)}-${hex.slice(4)}`
}

/** Xbox user ID for a gamertag (GeyserMC's public lookup); null if the gamertag doesn't exist. */
export async function xuidFor(gamertag: string): Promise<string | null> {
  try {
    const r = await api.httpJson<{ xuid?: number | string }>(`https://api.geysermc.org/v2/xbox/xuid/${encodeURIComponent(gamertag.trim())}`)
    return r?.xuid != null ? String(r.xuid) : null
  } catch {
    return null
  }
}

/** Which Geyser/Floodgate builds fit this server software (null = not possible). */
export type BedrockPlatform = 'spigot' | 'fabric' | 'neoforge'
export function bedrockPlatform(sw: Software): BedrockPlatform | null {
  if (sw === 'paper' || sw === 'purpur' || sw === 'folia' || sw === 'spigot') return 'spigot'
  if (sw === 'fabric' || sw === 'neoforge') return sw
  return null
}

export interface BedrockStatus {
  geyser: string | null
  floodgate: string | null
  /** Floodgate name prefix for Bedrock players */
  prefix: string
  replaceSpaces: boolean
  /** UDP port Geyser listens on */
  port: number
  geyserSha?: string
  floodgateSha?: string
}

export async function bedrockStatus(srv: McServer): Promise<BedrockStatus> {
  const r = await run(srv.hostId, `cd ${shq(srv.dir)} || exit 1
for f in plugins/*.jar mods/*.jar; do [ -f "$f" ] || continue
  case "$(printf '%s' "$f" | tr 'A-Z' 'a-z')" in
    *geyser*) echo "G|$f|$(sha256sum "$f" 2>/dev/null | cut -c1-64)" ;;
    *floodgate*) echo "F|$f|$(sha256sum "$f" 2>/dev/null | cut -c1-64)" ;;
  esac
done
echo '@@'; cat plugins/floodgate/config.yml config/floodgate/config.yml 2>/dev/null | grep -E '^(username-prefix|replace-spaces):' | head -2
echo '@@'; for c in plugins/Geyser-Spigot/config.yml config/Geyser-Fabric/config.yml config/Geyser-NeoForge/config.yml; do [ -f "$c" ] && awk '/^bedrock:/{b=1;next} /^[^ #]/{b=0} b && /^[ ]+port:/{print $2; exit}' "$c"; done`)
  const [files, conf, port] = r.stdout.split('@@')
  const lines = files.split('\n').filter((l) => /^[GF]\|/.test(l))
  const g = lines.find((l) => l.startsWith('G|'))?.split('|')
  const f = lines.find((l) => l.startsWith('F|'))?.split('|')
  const prefix = conf.match(/username-prefix:\s*["']?([^"'\n]*)["']?/)?.[1] ?? '.'
  return {
    geyser: g?.[1] ?? null,
    floodgate: f?.[1] ?? null,
    geyserSha: g?.[2],
    floodgateSha: f?.[2],
    prefix,
    replaceSpaces: !/replace-spaces:\s*false/.test(conf),
    port: parseInt(port.trim()) || 19132,
  }
}

export interface BedrockDownload { name: string; url: string; sha256?: string; sha1?: string; version: string }

/** Newest Geyser + Floodgate for the platform (GeyserMC downloads; Floodgate-Fabric from Modrinth). */
export async function bedrockDownloads(platform: BedrockPlatform, mcVersion: string): Promise<BedrockDownload[]> {
  const out: BedrockDownload[] = []
  for (const project of ['geyser', 'floodgate'] as const) {
    if (project === 'floodgate' && platform !== 'spigot') {
      const vs = await api.httpJson<any[]>(`https://api.modrinth.com/v2/project/floodgate/version?loaders=${encodeURIComponent(JSON.stringify([platform]))}&game_versions=${encodeURIComponent(JSON.stringify([mcVersion]))}`)
      const v = (vs ?? []).find((x) => x.version_type === 'release') ?? vs?.[0]
      const file = v?.files?.find((x: any) => x.primary) ?? v?.files?.[0]
      if (!file) throw new Error(`Floodgate for ${platform === 'fabric' ? 'Fabric' : 'NeoForge'} ${mcVersion} isn't available yet`)
      out.push({ name: file.filename, url: file.url, sha1: file.hashes?.sha1, version: v.version_number })
      continue
    }
    const b = await api.httpJson<any>(`https://download.geysermc.org/v2/projects/${project}/versions/latest/builds/latest`)
    const d = b?.downloads?.[platform]
    if (!d) throw new Error(`${project === 'geyser' ? 'Geyser' : 'Floodgate'} has no ${platform} build`)
    out.push({ name: d.name, url: `https://download.geysermc.org/v2/projects/${project}/versions/${b.version}/builds/${b.build}/downloads/${platform}`, sha256: d.sha256, version: `${b.version} (build ${b.build})` })
  }
  return out
}

/** Downloads Geyser + Floodgate (checksum-verified) and removes older copies. */
export function bedrockInstallScript(dir: string, platform: BedrockPlatform, files: BedrockDownload[]) {
  const dest = platform === 'spigot' ? 'plugins' : 'mods'
  const steps = files.map((f) => {
    const check = f.sha256
      ? `echo ${shq(`${f.sha256}  ${f.name}.part`)} | sha256sum -c - >/dev/null || { echo "Checksum mismatch for ${f.name}"; rm -f ${shq(f.name + '.part')}; exit 4; }`
      : f.sha1 ? `echo ${shq(`${f.sha1}  ${f.name}.part`)} | sha1sum -c - >/dev/null || { echo "Checksum mismatch for ${f.name}"; rm -f ${shq(f.name + '.part')}; exit 4; }` : 'true'
    const kind = /geyser/i.test(f.name) ? 'geyser' : 'floodgate'
    return `echo ${shq(`Downloading ${f.name} ${f.version}…`)}
if command -v curl >/dev/null; then curl -fsSL -o ${shq(f.name + '.part')} ${shq(f.url)}; else wget -q -O ${shq(f.name + '.part')} ${shq(f.url)}; fi
${check}
for old in *.jar; do case "$(printf '%s' "$old" | tr 'A-Z' 'a-z')" in *${kind}*) [ "$old" != ${shq(f.name)} ] && rm -f -- "$old" && echo "Removed old $old" ;; esac; done
mv -f ${shq(f.name + '.part')} ${shq(f.name)}`
  }).join('\n')
  return `set -e
mkdir -p ${shq(dir + '/' + dest)} && cd ${shq(dir + '/' + dest)}
${steps}
echo "Geyser and Floodgate are installed. Restart the server to let Bedrock players join."`
}

/** The whitelist/ops name Floodgate uses for a gamertag. */
export const bedrockName = (gamertag: string, st: Pick<BedrockStatus, 'prefix' | 'replaceSpaces'>) =>
  st.prefix + (st.replaceSpaces ? gamertag.trim().replace(/ /g, '_') : gamertag.trim())

/** Gamertag shown for a Floodgate name (prefix removed, underscores back to spaces are ambiguous, so kept). */
export const gamertagOf = (name: string, prefix = '.') => (prefix && name.startsWith(prefix) ? name.slice(prefix.length) : name)

export interface BedrockAttempt { name: string; uuid: string; when: string }

/**
 * Bedrock players seen in the server log (joined, or turned away by the whitelist), newest first.
 * Floodgate UUIDs come straight from the log, so no gamertag lookup is needed.
 */
export async function recentBedrockPlayers(srv: McServer): Promise<BedrockAttempt[]> {
  const r = await run(srv.hostId, `cd ${shq(srv.dir)} 2>/dev/null || exit 0
cat logs/latest.log .sshos/console.prev.log .sshos/console.log 2>/dev/null | sed 's/\\x1b\\[[0-9;]*m//g' | grep -aiE '00000000-0000-0000-' | tail -n 400`)
  const seen = new Map<string, BedrockAttempt>()
  for (const line of r.stdout.split('\n')) {
    const when = line.match(/\[(\d{2}:\d{2}:\d{2})/)?.[1] ?? ''
    let m = line.match(/id=(00000000-0000-0000-[0-9a-f]{4}-[0-9a-f]{12}),\s*name=([^,\]\s]+)/i)
      ?? line.match(/name=([^,\]\s]+),\s*id=(00000000-0000-0000-[0-9a-f]{4}-[0-9a-f]{12})/i)
    if (m && /^0{8}/.test(m[2])) m = [m[0], m[2], m[1]] as unknown as RegExpMatchArray
    const n = m ?? line.match(/logged in as (\S+) joined \(UUID: (00000000-0000-0000-[0-9a-f-]{17})\)/i)
      ?? line.match(/UUID of player (\S+) is (00000000-0000-0000-[0-9a-f-]{17})/i)
    if (!n) continue
    const [uuid, name] = n === m ? [n[1], n[2]] : [n[2], n[1]]
    seen.delete(uuid.toLowerCase())
    seen.set(uuid.toLowerCase(), { uuid: uuid.toLowerCase(), name, when })
  }
  return [...seen.values()].reverse()
}

/** "2535…" (XUID) or a Floodgate UUID typed instead of a gamertag. */
export function parseBedrockId(input: string): string | null {
  const t = input.trim()
  if (/^\d{12,20}$/.test(t)) return floodgateUuid(t)
  if (/^00000000-0000-0000-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(t)) return t.toLowerCase()
  return null
}
