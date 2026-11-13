import { api, shq } from '../api'
import { fetchCmd } from '../mc/server'
import { HAS_ICU, UNZIP_FN, type TrSoftware } from './server'

export const TML_APP = '1281930'
/** tModLoader generation that current releases and Workshop tags use */
export const TML_TAG = '1.4.4'

export interface TrRelease {
  version: string
  terraria?: string
  url: string
  fileName: string
  sha256?: string
  published?: string
}

function archOf(uname: string): 'x64' | 'arm64' | 'arm' | null {
  if (/x86_64|amd64/.test(uname)) return 'x64'
  if (/aarch64|arm64/.test(uname)) return 'arm64'
  if (/armv7|armhf/.test(uname)) return 'arm'
  return null
}

function digest(a: any): string | undefined {
  return typeof a?.digest === 'string' && /^sha256:[a-f0-9]{64}$/.test(a.digest) ? a.digest.slice(7) : undefined
}

/** Which server types can run on this CPU, with a reason when not. */
export function supportOn(sw: TrSoftware, uname: string): { ok: boolean; note?: string } {
  const a = archOf(uname)
  if (sw === 'vanilla') return a === 'x64' ? { ok: true } : { ok: false, note: 'The official server only exists for x86_64 Linux. Use TShock on this machine.' }
  if (sw === 'tmodloader') return a === 'x64' ? { ok: true } : a === 'arm64' ? { ok: true, note: 'tModLoader can run on ARM64, but Workshop mods need SteamCMD, which is x86_64 only. Upload .tmod files yourself instead.' } : { ok: false, note: 'tModLoader needs a 64-bit machine.' }
  return a ? { ok: true } : { ok: false, note: `Unsupported CPU: ${uname}` }
}

export async function latestRelease(sw: TrSoftware, uname: string): Promise<TrRelease> {
  if (sw === 'tshock') {
    const r = await api.httpJson('https://api.github.com/repos/Pryaxis/TShock/releases/latest')
    const a = archOf(uname)
    const asset = (r.assets as any[]).find((x) => x.name.includes(`linux-${a}`) && x.name.endsWith('.zip'))
    if (!asset) throw new Error(`TShock ${r.tag_name} has no build for ${uname}`)
    return { version: r.tag_name.replace(/^v/, ''), terraria: asset.name.match(/Terraria-([\d.]+?)-linux/)?.[1], url: asset.browser_download_url, fileName: asset.name, sha256: digest(asset), published: r.published_at }
  }
  if (sw === 'tmodloader') {
    const r = await api.httpJson('https://api.github.com/repos/tModLoader/tModLoader/releases/latest')
    const asset = (r.assets as any[]).find((x) => x.name === 'tModLoader.zip')
    if (!asset) throw new Error('tModLoader.zip not found in the latest release')
    return { version: r.tag_name.replace(/^v/, ''), url: asset.browser_download_url, fileName: asset.name, sha256: digest(asset), published: r.published_at }
  }
  const names = (await api.httpJson<string[]>('https://terraria.org/api/get/dedicated-servers-names')) ?? []
  const file = [...new Set(names)].sort().reverse()[0]
  if (!file) throw new Error('Could not find the Terraria server download')
  const build = file.match(/(\d+)/)?.[1] ?? ''
  return { version: build.split('').join('.'), terraria: build.split('').join('.'), url: `https://terraria.org/api/download/pc-dedicated-server/${file}`, fileName: file }
}

/** Shell script that installs (or updates in place) the server files into `dir`. Worlds/config are kept. */
/**
 * TShock is framework-dependent: it needs the .NET runtime version it was built for
 * (read from ServerPlugins/TShockAPI.deps.json). Installs it into ~/.sshos/dotnet with
 * Microsoft's official dotnet-install.sh: no sudo, nothing system-wide.
 */
export const DOTNET_ENSURE = `CH=$(grep -o 'NETCoreApp,Version=v[0-9.]*' "$D/ServerPlugins/TShockAPI.deps.json" 2>/dev/null | head -1 | sed 's/.*v//')
DN="$HOME/.sshos/dotnet"
if [ -n "$CH" ]; then
  if "$DN/dotnet" --list-runtimes 2>/dev/null | grep -q "Microsoft.NETCore.App $CH\\."; then
    echo ".NET $CH runtime already installed"
  elif command -v dotnet >/dev/null 2>&1 && dotnet --list-runtimes 2>/dev/null | grep -q "Microsoft.NETCore.App $CH\\."; then
    echo "Using the system .NET $CH runtime"
  else
    echo "Installing the .NET $CH runtime into ~/.sshos/dotnet (needed by TShock)…"
    ${fetchCmd('https://dot.net/v1/dotnet-install.sh', '$T/dotnet-install.sh').replaceAll(`'$T/dotnet-install.sh'`, '"$T/dotnet-install.sh"')}
    bash "$T/dotnet-install.sh" --runtime dotnet --channel "$CH" --install-dir "$DN" --no-path 2>&1 | grep -vE '^dotnet-install: (Attempting|Remote file|Downloading|Extracting|Adding to)' | tail -n 5
    "$DN/dotnet" --list-runtimes | grep -q "Microsoft.NETCore.App $CH\\." || { echo "The .NET runtime could not be installed"; exit 9; }
  fi
fi
if ! { ${HAS_ICU}; } >/dev/null 2>&1; then
  echo "NOTE: Terraria needs the ICU library (libicu), which is not installed on this server."
  echo "      Install it once with sudo: SSH OS shows an Install button in the Overview."
fi`

export function installScript(sw: TrSoftware, rel: TrRelease, dir: string): string {
  const check = rel.sha256 ? `if command -v sha256sum >/dev/null; then echo "${rel.sha256}  $T/dl.zip" | sha256sum -c - >/dev/null && echo "Checksum OK" || { echo "Checksum mismatch"; exit 4; }; fi` : ''
  const common = `set -e
${UNZIP_FN}
D=${shq(dir)}
mkdir -p "$D"
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
echo "Downloading ${rel.fileName}…"
${fetchCmd(rel.url, '$T/dl.zip').replaceAll(`'$T/dl.zip'`, '"$T/dl.zip"')}
${check}
mkdir -p "$T/x"; unz "$T/dl.zip" "$T/x"
`
  if (sw === 'tshock') {
    return `${common}
cd "$T/x"; for t in *.tar; do [ -f "$t" ] && tar xf "$t" && rm -f "$t"; done
# keep worlds, configs (tshock/) and installed plugins on update
cp -a "$T/x/." "$D/"
chmod +x "$D/TShock.Server" "$D/TShock.Installer" 2>/dev/null || true
mkdir -p "$D/worlds" "$D/ServerPlugins"
${DOTNET_ENSURE}
echo "Installed TShock ${rel.version}${rel.terraria ? ` (Terraria ${rel.terraria})` : ''}"`
  }
  if (sw === 'tmodloader') {
    return `${common}
cp -a "$T/x/." "$D/"
chmod +x "$D"/*.sh "$D"/LaunchUtils/*.sh 2>/dev/null || true
mkdir -p "$D/worlds" "$D/data/Mods" "$D/steamapps/workshop"
[ -f "$D/data/Mods/enabled.json" ] || echo "[]" > "$D/data/Mods/enabled.json"
echo "Installed tModLoader ${rel.version}. The first start downloads the .NET runtime (about 70 MB)."`
  }
  return `${common}
SRC=$(find "$T/x" -type d -path '*/Linux' | head -1)
[ -n "$SRC" ] || { echo "Linux server not found in the download"; exit 6; }
cp -a "$SRC/." "$D/"
chmod +x "$D/TerrariaServer.bin.x86_64" "$D/TerrariaServer" 2>/dev/null || true
mkdir -p "$D/worlds"
echo "Installed Terraria server ${rel.version}"`
}

// ------------------------------------------------------------------ TShock plugins (GitHub)
export interface PluginRepo {
  repo: string
  title: string
  description: string
  stars: number
  updated: string
  url: string
  avatar?: string
}

export async function searchPlugins(q: string): Promise<PluginRepo[]> {
  const query = encodeURIComponent(`${q ? q + ' ' : ''}topic:tshock-plugin`)
  const r = await api.httpJson(`https://api.github.com/search/repositories?q=${query}&sort=stars&order=desc&per_page=30`)
  let items = (r?.items ?? []) as any[]
  if (!items.length && q) {
    const r2 = await api.httpJson(`https://api.github.com/search/repositories?q=${encodeURIComponent(q + ' tshock in:name,description,readme')}&sort=stars&per_page=30`)
    items = r2?.items ?? []
  }
  return items.map((x) => ({ repo: x.full_name, title: x.name, description: x.description ?? '', stars: x.stargazers_count, updated: x.pushed_at, url: x.html_url, avatar: x.owner?.avatar_url }))
}

export interface PluginRelease {
  tag: string
  published: string
  assets: { name: string; url: string; sha256?: string }[]
  /** TShock major version mentioned by the release, if any */
  forTShock?: number
}

export async function latestPluginRelease(repo: string): Promise<PluginRelease | null> {
  const r = await api.httpJson(`https://api.github.com/repos/${repo}/releases/latest`).catch(() => null)
  if (!r?.tag_name) return null
  const text = `${r.name ?? ''} ${r.tag_name} ${r.body ?? ''}`
  const m = text.match(/TShock\s*(?:API\s*)?v?(\d+)(?:\.\d+)*/i)
  return {
    tag: r.tag_name,
    published: r.published_at,
    assets: (r.assets as any[]).filter((a) => /\.(dll|zip)$/i.test(a.name)).map((a) => ({ name: a.name, url: a.browser_download_url, sha256: digest(a) })),
    forTShock: m ? parseInt(m[1]) : undefined,
  }
}

/** Plugins built for an older TShock major usually fail to load (API changes). */
export function pluginCompat(rel: PluginRelease | null, tshockVersion: string, tshockMajorDate?: string): { status: 'ok' | 'incompatible' | 'unknown'; reason?: string } {
  const major = parseInt(tshockVersion) || 0
  if (!rel) return { status: 'unknown', reason: 'No release with a downloadable plugin.' }
  if (rel.forTShock && major && rel.forTShock !== major) return { status: 'incompatible', reason: `Built for TShock ${rel.forTShock}, server runs TShock ${tshockVersion}.` }
  if (tshockMajorDate && rel.published < tshockMajorDate && !rel.forTShock) return { status: 'incompatible', reason: `Released before TShock ${major} came out; it was probably built for an older TShock.` }
  return rel.forTShock ? { status: 'ok' } : { status: 'unknown' }
}

/** When the installed TShock major (e.g. 6.0.0) was first released. */
export async function tshockMajorDate(version: string): Promise<string | undefined> {
  const major = parseInt(version)
  if (!major) return undefined
  const r = (await api.httpJson<any[]>('https://api.github.com/repos/Pryaxis/TShock/releases?per_page=100').catch(() => [])) ?? []
  const firsts = r.filter((x) => parseInt(x.tag_name.replace(/^v/, '')) === major && !x.prerelease).map((x) => x.published_at).sort()
  return firsts[0]
}

// ------------------------------------------------------------------ tModLoader mods (Steam Workshop)
export interface WorkshopItem {
  id: string
  title: string
  description: string
  preview?: string
  size: number
  updated: number
  subscriptions: number
  tags: string[]
}

export async function workshopDetails(ids: string[]): Promise<WorkshopItem[]> {
  if (!ids.length) return []
  const form: Record<string, string> = { itemcount: String(ids.length) }
  ids.forEach((id, i) => (form[`publishedfileids[${i}]`] = id))
  const r = await api.httpJson('https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/', { method: 'POST', form })
  return ((r?.response?.publishedfiledetails ?? []) as any[])
    .filter((d) => d.result === 1 && String(d.consumer_app_id) === TML_APP)
    .map((d) => ({
      id: String(d.publishedfileid),
      title: d.title,
      description: String(d.description ?? '').replace(/\[[^\]]+\]/g, '').slice(0, 300),
      preview: d.preview_url,
      size: +d.file_size || 0,
      updated: (d.time_updated ?? 0) * 1000,
      subscriptions: d.lifetime_subscriptions ?? d.subscriptions ?? 0,
      tags: (d.tags ?? []).map((t: any) => t.tag),
    }))
}

/** Search the tModLoader Workshop (scrapes the public browse page, then loads details from the Web API). */
export async function searchWorkshop(q: string, page = 1): Promise<WorkshopItem[]> {
  const sort = q ? 'textsearch' : 'trend'
  const url = `https://steamcommunity.com/workshop/browse/?appid=${TML_APP}&searchtext=${encodeURIComponent(q)}&browsesort=${sort}&actualsort=${sort}&section=readytouseitems&days=-1&p=${page}`
  const html = await api.httpText(url)
  const ids = [...new Set([...html.matchAll(/filedetails\/\?id=(\d+)/g)].map((m) => m[1]))].slice(0, 30)
  const details = await workshopDetails(ids)
  return ids.map((id) => details.find((d) => d.id === id)).filter(Boolean) as WorkshopItem[]
}

/** Workshop tags carry the tModLoader generation ("1.4.3", "1.4.4"). */
export function modCompat(tags: string[]): { status: 'ok' | 'incompatible' | 'unknown'; reason?: string } {
  const gens = tags.filter((t) => /^1\.\d+(\.\d+)?$/.test(t))
  if (!gens.length) return { status: 'unknown' }
  if (gens.includes(TML_TAG)) return { status: 'ok' }
  return { status: 'incompatible', reason: `Made for tModLoader ${gens.join(', ')}; current servers run ${TML_TAG}.` }
}

/** SteamCMD (x86_64) installed into ~/.sshos/steamcmd without sudo. */
export const STEAMCMD_SH = `S="$HOME/.sshos/steamcmd"
if [ ! -x "$S/steamcmd.sh" ]; then
  echo "Installing SteamCMD into ~/.sshos/steamcmd…"
  mkdir -p "$S"
  ${fetchCmd('https://steamcdn-a.akamaihd.net/client/installer/steamcmd_linux.tar.gz', '$S/steamcmd.tgz').replaceAll(`'$S/steamcmd.tgz'`, '"$S/steamcmd.tgz"')}
  tar xzf "$S/steamcmd.tgz" -C "$S" && rm -f "$S/steamcmd.tgz"
fi
STEAMCMD="$S/steamcmd.sh"`

export function workshopInstallScript(dir: string, ids: string[]): string {
  const items = ids.map((id) => `+workshop_download_item ${TML_APP} ${id}`).join(' ')
  return `set -e
${STEAMCMD_SH}
cd ${shq(dir)}
echo "Downloading ${ids.length} mod${ids.length > 1 ? 's' : ''} from the Steam Workshop…"
"$STEAMCMD" +force_install_dir ${shq(dir)} +login anonymous ${items} +quit 2>&1 | grep -vE '^\\s*$' | tail -n 25 || {
  echo
  echo "SteamCMD failed. On Debian/Ubuntu it needs 32-bit libraries: sudo dpkg --add-architecture i386 && sudo apt update && sudo apt install lib32gcc-s1"
  exit 7
}
for id in ${ids.map(shq).join(' ')}; do [ -d "steamapps/workshop/content/${TML_APP}/$id" ] || { echo "Mod $id was not downloaded"; exit 8; }; done
echo "Done."`
}
