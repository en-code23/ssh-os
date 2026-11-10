import { api } from '../api'

// ------------------------------------------------------------------
// Server software
// ------------------------------------------------------------------
export type Software = 'paper' | 'purpur' | 'folia' | 'fabric' | 'vanilla' | 'spigot' | 'forge' | 'neoforge' | 'custom'

export interface SoftwareInfo {
  id: Software
  name: string
  blurb: string
  help: string
  /** what kind of add-ons it runs */
  content: 'plugins' | 'mods' | 'none'
  /** Modrinth loader names usable for this server */
  loaders: string[]
  creatable: boolean
  autoUpdate: boolean
  color: string
}

export const SOFTWARE: Record<Software, SoftwareInfo> = {
  paper: {
    id: 'paper', name: 'Paper', color: '#3b82f6', content: 'plugins', loaders: ['paper', 'spigot', 'bukkit'], creatable: true, autoUpdate: true,
    blurb: 'Fast, stable, runs Bukkit/Spigot/Paper plugins. Recommended.',
    help: 'Paper is a high-performance fork of Spigot. It fixes gameplay and performance issues, runs almost every Bukkit/Spigot plugin, and receives frequent updates. Choose it unless you specifically need mods.',
  },
  purpur: {
    id: 'purpur', name: 'Purpur', color: '#a855f7', content: 'plugins', loaders: ['purpur', 'paper', 'spigot', 'bukkit'], creatable: true, autoUpdate: true,
    blurb: 'Paper fork with hundreds of extra gameplay options.',
    help: 'Purpur is built on Paper and adds many configurable gameplay tweaks (rideable mobs, extra config in purpur.yml). Use it if you want more knobs than Paper offers; it runs the same plugins.',
  },
  folia: {
    id: 'folia', name: 'Folia', color: '#22c55e', content: 'plugins', loaders: ['folia'], creatable: true, autoUpdate: true,
    blurb: 'Multithreaded regions for very large servers. Few plugins support it.',
    help: 'Folia splits the world into regions ticked on separate threads. It only helps large servers with many spread-out players, and plugins must explicitly support Folia. Not recommended for small servers.',
  },
  fabric: {
    id: 'fabric', name: 'Fabric', color: '#d6b98c', content: 'mods', loaders: ['fabric'], creatable: true, autoUpdate: true,
    blurb: 'Lightweight mod loader. Runs Fabric mods (e.g. Lithium, mod packs).',
    help: 'Fabric loads server-side mods instead of plugins. Players may need the same mods installed in their client for content mods. Install the "Fabric API" mod, which most mods require.',
  },
  vanilla: {
    id: 'vanilla', name: 'Vanilla', color: '#16a34a', content: 'none', loaders: [], creatable: true, autoUpdate: true,
    blurb: 'The official Mojang server. No plugins or mods.',
    help: 'The unmodified server from Mojang. It only supports data packs, so choose Paper if you might want plugins later.',
  },
  spigot: {
    id: 'spigot', name: 'Spigot', color: '#f59e0b', content: 'plugins', loaders: ['spigot', 'bukkit'], creatable: false, autoUpdate: false,
    blurb: 'Classic plugin server (must be built with BuildTools).',
    help: 'Spigot cannot be downloaded directly; it is compiled with BuildTools. Paper is a drop-in replacement that is faster and auto-updatable.',
  },
  forge: { id: 'forge', name: 'Forge', color: '#64748b', content: 'mods', loaders: ['forge'], creatable: false, autoUpdate: false, blurb: 'Classic mod loader.', help: 'Forge servers are started with run.sh. SSH OS manages them with a custom start command.' },
  neoforge: { id: 'neoforge', name: 'NeoForge', color: '#f97316', content: 'mods', loaders: ['neoforge'], creatable: false, autoUpdate: false, blurb: 'Modern Forge fork.', help: 'NeoForge servers are started with run.sh. SSH OS manages them with a custom start command.' },
  custom: { id: 'custom', name: 'Custom', color: '#8e8e93', content: 'plugins', loaders: ['paper', 'spigot', 'bukkit'], creatable: false, autoUpdate: false, blurb: 'Unknown server jar.', help: 'SSH OS could not identify the server software. You can still start/stop it and edit its settings.' },
}

export interface McVersion {
  id: string
  stable: boolean
}

const FILL = 'https://fill.papermc.io/v3/projects'
const isStable = (v: string) => !/(-|snapshot|pre|rc|w\d)/i.test(v)

export async function listVersions(sw: Software): Promise<McVersion[]> {
  switch (sw) {
    case 'paper':
    case 'folia': {
      const r = await api.httpJson(`${FILL}/${sw}`)
      const all: string[] = Object.values(r.versions as Record<string, string[]>).flat()
      return all.map((id) => ({ id, stable: isStable(id) }))
    }
    case 'purpur': {
      const r = await api.httpJson('https://api.purpurmc.org/v2/purpur')
      return (r.versions as string[]).slice().reverse().map((id) => ({ id, stable: isStable(id) }))
    }
    case 'fabric': {
      const r = await api.httpJson('https://meta.fabricmc.net/v2/versions/game')
      return (r as { version: string; stable: boolean }[]).map((v) => ({ id: v.version, stable: v.stable }))
    }
    default: {
      const r = await api.httpJson('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json')
      return (r.versions as { id: string; type: string }[]).map((v) => ({ id: v.id, stable: v.type === 'release' }))
    }
  }
}

export interface ServerDownload {
  url: string
  fileName: string
  build: string
  sha256?: string
  sha1?: string
  javaMin?: number
  recommendedFlags?: string[]
}

/** Resolve the newest build of `sw` for `version`. */
export async function resolveServerJar(sw: Software, version: string): Promise<ServerDownload> {
  switch (sw) {
    case 'paper':
    case 'folia': {
      const [b, info] = await Promise.all([
        api.httpJson(`${FILL}/${sw}/versions/${encodeURIComponent(version)}/builds/latest`),
        api.httpJson(`${FILL}/${sw}/versions/${encodeURIComponent(version)}`).catch(() => null),
      ])
      if (!b) throw new Error(`No ${SOFTWARE[sw].name} build for ${version}`)
      const d = b.downloads['server:default']
      return {
        url: d.url, fileName: d.name, build: String(b.id), sha256: d.checksums?.sha256,
        javaMin: info?.version?.java?.version?.minimum, recommendedFlags: info?.version?.java?.flags?.recommended,
      }
    }
    case 'purpur': {
      const r = await api.httpJson(`https://api.purpurmc.org/v2/purpur/${encodeURIComponent(version)}`)
      if (!r) throw new Error(`No Purpur build for ${version}`)
      const build = r.builds.latest
      return { url: `https://api.purpurmc.org/v2/purpur/${version}/${build}/download`, fileName: `purpur-${version}-${build}.jar`, build: String(build), javaMin: await javaFor(version) }
    }
    case 'fabric': {
      const [loaders, installers] = await Promise.all([
        api.httpJson(`https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(version)}`),
        api.httpJson('https://meta.fabricmc.net/v2/versions/installer'),
      ])
      const loader = (loaders as any[]).find((l) => l.loader.stable)?.loader.version ?? loaders?.[0]?.loader.version
      const installer = (installers as any[]).find((i) => i.stable)?.version ?? installers[0].version
      if (!loader) throw new Error(`Fabric does not support ${version}`)
      return {
        url: `https://meta.fabricmc.net/v2/versions/loader/${version}/${loader}/${installer}/server/jar`,
        fileName: `fabric-server-mc.${version}-loader.${loader}-launcher.${installer}.jar`,
        build: `${loader}/${installer}`,
        javaMin: await javaFor(version),
      }
    }
    case 'vanilla': {
      const m = await api.httpJson('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json')
      const v = (m.versions as any[]).find((x) => x.id === version)
      if (!v) throw new Error(`Unknown Minecraft version ${version}`)
      const j = await api.httpJson(v.url)
      if (!j.downloads?.server) throw new Error(`Mojang provides no server for ${version}`)
      return { url: j.downloads.server.url, fileName: `minecraft_server.${version}.jar`, build: version, sha1: j.downloads.server.sha1, javaMin: j.javaVersion?.majorVersion }
    }
    default:
      throw new Error(`${SOFTWARE[sw].name} cannot be downloaded automatically`)
  }
}

/** Java major version needed for a Minecraft version. */
export async function javaFor(version: string): Promise<number> {
  try {
    const m = await api.httpJson('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json')
    const v = (m.versions as any[]).find((x) => x.id === version)
    if (v) {
      const j = await api.httpJson(v.url)
      if (j?.javaVersion?.majorVersion) return j.javaVersion.majorVersion
    }
  } catch { /* fall back */ }
  return javaGuess(version)
}

export function javaGuess(version: string): number {
  const [a, b = 0, c = 0] = version.split(/[.-]/).map((x) => parseInt(x) || 0)
  if (a >= 26) return 25
  if (a === 1 && (b > 20 || (b === 20 && c >= 5))) return 21
  if (a === 1 && b >= 18) return 17
  if (a === 1 && b === 17) return 16
  return 8
}

export const AIKAR_FLAGS =
  '-XX:+UseG1GC -XX:+ParallelRefProcEnabled -XX:MaxGCPauseMillis=200 -XX:+UnlockExperimentalVMOptions -XX:+DisableExplicitGC -XX:+AlwaysPreTouch -XX:G1NewSizePercent=30 -XX:G1MaxNewSizePercent=40 -XX:G1HeapRegionSize=8M -XX:G1ReservePercent=20 -XX:G1HeapWastePercent=5 -XX:G1MixedGCCountTarget=4 -XX:InitiatingHeapOccupancyPercent=15 -XX:G1MixedGCLiveThresholdPercent=90 -XX:G1RSetUpdatingPauseTimePercent=5 -XX:SurvivorRatio=32 -XX:+PerfDisableSharedMem -XX:MaxTenuringThreshold=1 -Dusing.aikars.flags=https://mcflags.emc.gs -Daikars.new.flags=true'

/** Adoptium Temurin JRE download (tar.gz) for a Linux arch from `uname -m`. */
export function temurinUrl(major: number, unameArch: string) {
  const arch = /x86_64|amd64/.test(unameArch) ? 'x64' : /aarch64|arm64/.test(unameArch) ? 'aarch64' : /armv7|armhf/.test(unameArch) ? 'arm' : /ppc64le/.test(unameArch) ? 'ppc64le' : /s390x/.test(unameArch) ? 's390x' : 'x64'
  return `https://api.adoptium.net/v3/binary/latest/${major}/ga/linux/${arch}/jre/hotspot/normal/eclipse`
}

// ------------------------------------------------------------------
// Content (plugins, mods, data packs, resource packs)
// ------------------------------------------------------------------
export type ContentKind = 'plugin' | 'mod' | 'datapack' | 'resourcepack'
export type ContentSource = 'modrinth' | 'hangar' | 'spigot'

export interface ContentHit {
  source: ContentSource
  id: string
  slug: string
  title: string
  author: string
  description: string
  icon?: string
  downloads: number
  updated?: string
  kind: ContentKind
  url: string
  categories?: string[]
  /** Spigot/Hangar entries that are hosted elsewhere */
  external?: boolean
}

export interface ContentVersion {
  id: string
  name: string
  version: string
  gameVersions: string[]
  loaders: string[]
  date: string
  url?: string
  fileName?: string
  sha1?: string
  externalUrl?: string
  channel?: string
  dependencies?: { projectId: string; type: string }[]
}

const MR = 'https://api.modrinth.com/v2'

export async function searchContent(
  source: ContentSource,
  q: string,
  kind: ContentKind,
  opts: { loaders: string[]; version?: string; sort: 'relevance' | 'downloads' | 'updated'; offset?: number },
): Promise<{ hits: ContentHit[]; total: number }> {
  if (source === 'modrinth') {
    const facets: string[][] = [[`project_type:${kind}`]]
    if (kind === 'plugin' || kind === 'mod') if (opts.loaders.length) facets.push(opts.loaders.map((l) => `categories:${l}`))
    if (kind === 'datapack') facets.push(['categories:datapack'])
    if (opts.version) facets.push([`versions:${opts.version}`])
    const index = opts.sort === 'updated' ? 'updated' : opts.sort === 'downloads' ? 'downloads' : 'relevance'
    const r = await api.httpJson(
      `${MR}/search?query=${encodeURIComponent(q)}&limit=30&offset=${opts.offset ?? 0}&index=${index}&facets=${encodeURIComponent(JSON.stringify(facets))}`,
    )
    return {
      total: r.total_hits,
      hits: (r.hits as any[]).map((h) => ({
        source, id: h.project_id, slug: h.slug, title: h.title, author: h.author, description: h.description, icon: h.icon_url || undefined,
        downloads: h.downloads, updated: h.date_modified, kind, url: `https://modrinth.com/${h.project_type}/${h.slug}`, categories: h.display_categories,
      })),
    }
  }
  if (source === 'hangar') {
    const sort = opts.sort === 'downloads' ? '-downloads' : opts.sort === 'updated' ? '-updated' : ''
    const plat = opts.loaders.includes('velocity') ? 'VELOCITY' : 'PAPER'
    const r = await api.httpJson(
      `https://hangar.papermc.io/api/v1/projects?limit=30&offset=${opts.offset ?? 0}&platform=${plat}${q ? `&q=${encodeURIComponent(q)}` : ''}${sort ? `&sort=${sort}` : ''}${opts.version ? `&version=${encodeURIComponent(opts.version)}` : ''}`,
    )
    return {
      total: r.pagination.count,
      hits: (r.result as any[]).map((p) => ({
        source, id: `${p.namespace.owner}/${p.namespace.slug}`, slug: p.namespace.slug, title: p.name, author: p.namespace.owner, description: p.description,
        icon: p.avatarUrl, downloads: p.stats.downloads, updated: p.lastUpdated, kind: 'plugin', url: `https://hangar.papermc.io/${p.namespace.owner}/${p.namespace.slug}`, categories: [p.category],
      })),
    }
  }
  // spigot via Spiget
  const fields = 'id,name,tag,icon,downloads,updateDate,external,file,author,testedVersions'
  const sort = opts.sort === 'updated' ? '-updateDate' : '-downloads'
  const url = q
    ? `https://api.spiget.org/v2/search/resources/${encodeURIComponent(q)}?size=30&page=${Math.floor((opts.offset ?? 0) / 30) + 1}&sort=${sort}&fields=${fields}`
    : `https://api.spiget.org/v2/resources/free?size=30&page=${Math.floor((opts.offset ?? 0) / 30) + 1}&sort=${sort}&fields=${fields}`
  const r = ((await api.httpJson(url)) ?? []) as any[]
  return {
    total: r.length < 30 ? (opts.offset ?? 0) + r.length : (opts.offset ?? 0) + 60,
    hits: r.map((p) => ({
      source, id: String(p.id), slug: String(p.id), title: p.name, author: p.author?.id ? `#${p.author.id}` : '', description: p.tag, downloads: p.downloads,
      icon: p.icon?.data ? `data:image/png;base64,${p.icon.data}` : undefined,
      updated: p.updateDate ? new Date(p.updateDate * 1000).toISOString() : undefined, kind: 'plugin', external: !!p.external,
      url: `https://www.spigotmc.org/resources/${p.id}/`, categories: p.testedVersions?.slice(-3),
    })),
  }
}

export async function listContentVersions(hit: Pick<ContentHit, 'source' | 'id' | 'kind'>, loaders: string[], version?: string): Promise<ContentVersion[]> {
  if (hit.source === 'modrinth') {
    const params = new URLSearchParams()
    if ((hit.kind === 'plugin' || hit.kind === 'mod') && loaders.length) params.set('loaders', JSON.stringify(loaders))
    if (hit.kind === 'datapack') params.set('loaders', JSON.stringify(['datapack']))
    if (version) params.set('game_versions', JSON.stringify([version]))
    const r = ((await api.httpJson(`${MR}/project/${hit.id}/version?${params}`)) ?? []) as any[]
    return r.map(mrVersion)
  }
  if (hit.source === 'hangar') {
    const plat = loaders.includes('velocity') ? 'VELOCITY' : 'PAPER'
    const r = await api.httpJson(`https://hangar.papermc.io/api/v1/projects/${hit.id.split('/')[1]}/versions?limit=25&platform=${plat}${version ? `&platformVersion=${encodeURIComponent(version)}` : ''}`)
    return ((r?.result ?? []) as any[]).map((v) => {
      const d = v.downloads?.[plat] ?? Object.values(v.downloads ?? {})[0] as any
      return {
        id: String(v.id), name: v.name, version: v.name, gameVersions: v.platformDependencies?.[plat] ?? [], loaders: [plat.toLowerCase()],
        date: v.createdAt, url: d?.downloadUrl ?? undefined, fileName: d?.fileInfo?.name, externalUrl: d?.externalUrl ?? undefined, channel: v.channel?.name,
      }
    })
  }
  const r = ((await api.httpJson(`https://api.spiget.org/v2/resources/${hit.id}/versions?size=15&sort=-releaseDate`)) ?? []) as any[]
  const res = await api.httpJson(`https://api.spiget.org/v2/resources/${hit.id}?fields=external,file,testedVersions,name`)
  return r.map((v, i) => ({
    id: String(v.id), name: v.name, version: v.name, gameVersions: res?.testedVersions ?? [], loaders: ['spigot'], date: new Date(v.releaseDate * 1000).toISOString(),
    // Spiget can only serve the newest file
    url: i === 0 && !res?.external ? `https://api.spiget.org/v2/resources/${hit.id}/download` : undefined,
    externalUrl: res?.external ? (res.file?.externalUrl as string) : undefined,
    fileName: `${(res?.name ?? 'plugin').replace(/[^\w.-]+/g, '')}.jar`,
  }))
}

function mrVersion(v: any): ContentVersion {
  const f = v.files.find((x: any) => x.primary) ?? v.files[0]
  return {
    id: v.id, name: v.name, version: v.version_number, gameVersions: v.game_versions, loaders: v.loaders, date: v.date_published,
    url: f?.url, fileName: f?.filename, sha1: f?.hashes?.sha1, channel: v.version_type,
    dependencies: (v.dependencies ?? []).filter((d: any) => d.project_id).map((d: any) => ({ projectId: d.project_id, type: d.dependency_type })),
  }
}

export async function modrinthProject(id: string) {
  return api.httpJson(`${MR}/project/${id}`)
}

/** Turn a GitHub releases page into a direct .jar link, if possible. */
export async function resolveExternal(url: string): Promise<{ url: string; fileName: string } | null> {
  if (/\.jar(\?|$)/i.test(url)) return { url, fileName: decodeURIComponent(url.split('/').pop()!.split('?')[0]) }
  const m = url.match(/github\.com\/([^/]+)\/([^/#?]+)/)
  if (!m) return null
  const tag = url.match(/releases\/tag\/([^/#?]+)/)?.[1]
  const rel = await api.httpJson(`https://api.github.com/repos/${m[1]}/${m[2]}/releases/${tag ? `tags/${tag}` : 'latest'}`).catch(() => null)
  const jars = ((rel?.assets ?? []) as any[]).filter((a) => a.name.endsWith('.jar') && !/sources|javadoc|api/i.test(a.name))
  if (!jars.length) return null
  const pick = jars.find((a) => /bukkit|paper|spigot/i.test(a.name)) ?? jars.sort((a, b) => a.name.length - b.name.length)[0]
  return { url: pick.browser_download_url, fileName: pick.name }
}

export async function mojangUuid(name: string): Promise<{ id: string; name: string } | null> {
  const r = await api.httpJson(`https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(name)}`)
  if (!r?.id) return null
  const id = r.id.replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5')
  return { id, name: r.name }
}

export function fmtNum(n: number) {
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'k'
  return String(n)
}
