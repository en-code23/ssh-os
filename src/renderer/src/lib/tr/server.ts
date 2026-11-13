import { api, shq } from '../api'
import { MC_DIR, RUN_SH, run, Schedule, syncCron, type McConfig } from '../mc/server'

// ------------------------------------------------------------------ types
export type TrSoftware = 'tshock' | 'tmodloader' | 'vanilla'

export const TR_SOFTWARE: Record<TrSoftware, { name: string; blurb: string; help: string; color: string; content: 'plugins' | 'mods' | 'none' }> = {
  tshock: {
    name: 'TShock', color: '#3b82f6', content: 'plugins',
    blurb: 'Vanilla gameplay plus admin tools, permissions and plugins. Runs on x86_64 and ARM.',
    help: 'TShock is the most popular Terraria server: players join with the normal game, and you get user accounts, groups/permissions, anti-cheat, warps and many plugins. Recommended for most servers and the only option on ARM machines such as a Raspberry Pi.',
  },
  tmodloader: {
    name: 'tModLoader', color: '#16a34a', content: 'mods',
    blurb: 'Modded Terraria (Calamity, Thorium…). Mods from the Steam Workshop.',
    help: 'tModLoader runs Terraria mods. Every player needs tModLoader (free on Steam) and the mods are downloaded automatically when they join. Mods are installed from the Steam Workshop with SteamCMD, which needs an x86_64 server.',
  },
  vanilla: {
    name: 'Vanilla', color: '#8b5a2b', content: 'none',
    blurb: 'The official dedicated server from Re-Logic. No plugins or mods. x86_64 only.',
    help: 'The unmodified Terraria dedicated server. Simple and official, but without admin tools or plugins. Only available for x86_64 Linux.',
  },
}

export interface TrContentRecord {
  source: 'github' | 'workshop' | 'url'
  id: string
  title: string
  version?: string
}

export interface TrConfig {
  game: 'terraria'
  id: string
  name: string
  software: TrSoftware
  /** TShock / tModLoader / server version that is installed */
  version: string
  /** Terraria game version (e.g. 1.4.5.8) when known */
  terraria?: string
  session: string
  restartOnCrash: boolean
  maxCrashRestarts: number
  stopWarnSeconds: number
  stopTimeout: number
  autoStart: boolean
  restartSchedule: Schedule
  updates: { server: boolean; content: boolean; followLatest: boolean; schedule: Schedule; restart: 'never' | 'always' }
  backups: { schedule: Schedule; keep: number; scope: 'worlds' | 'full'; dir: string }
  content: Record<string, TrContentRecord>
  createdAt: number
  /** server website */
  web?: import('../web/site').WebSettings
}

export interface TrServer {
  game: 'terraria'
  hostId: string
  dir: string
  managed: boolean
  config: TrConfig
  running: boolean
  pid?: number
  external?: boolean
  port: number
  maxPlayers: number
  motd: string
  world: string
  /** used by the shared Backups panel */
  levelName: string
  worldPaths: string[]
}

export const TR_FILE = 'tr.json'

/** Terraria/TShock need the ICU library; this prints "icu" when it's installed. */
export const HAS_ICU = `(ldconfig -p 2>/dev/null | grep -q libicuuc && exit 0; for f in /usr/lib*/libicuuc.so* /usr/lib/*/libicuuc.so* /lib/*/libicuuc.so* /usr/local/lib/libicuuc.so*; do [ -e "$f" ] && exit 0; done; exit 1) && echo icu`
/** Installs ICU with the system package manager (needs sudo). */
export const INSTALL_ICU = `if command -v apt-get >/dev/null; then sudo apt-get update && sudo apt-get install -y libicu-dev; elif command -v dnf >/dev/null; then sudo dnf install -y libicu; elif command -v yum >/dev/null; then sudo yum install -y libicu; elif command -v apk >/dev/null; then sudo apk add icu-libs; elif command -v pacman >/dev/null; then sudo pacman -S --noconfirm icu; else echo "Install the ICU library (libicu) with your package manager"; fi`
export const WORLD_DIR = 'worlds'

export function defaultTrConfig(p: Partial<TrConfig> & { name: string; software: TrSoftware; version: string }): TrConfig {
  return {
    game: 'terraria',
    id: Math.random().toString(36).slice(2, 10),
    session: 'tr-' + p.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24),
    restartOnCrash: true,
    maxCrashRestarts: 5,
    stopWarnSeconds: 10,
    stopTimeout: 60,
    autoStart: false,
    restartSchedule: { kind: 'off' },
    updates: { server: false, content: false, followLatest: false, schedule: { kind: 'off' }, restart: 'never' },
    backups: { schedule: { kind: 'off' }, keep: 7, scope: 'worlds', dir: 'backups' },
    content: {},
    createdAt: Date.now(),
    ...p,
  }
}

// ------------------------------------------------------------------ serverconfig.txt
/** Terraria's serverconfig.txt is plain key=value (no escaping), '#' comments. */
export function parseServerConfig(text: string): Record<string, string> {
  const v: Record<string, string> = {}
  for (const l of text.split('\n')) {
    const t = l.replace(/\r$/, '')
    if (!t.trim() || t.trim().startsWith('#')) continue
    const i = t.indexOf('=')
    if (i > 0) v[t.slice(0, i).trim()] = t.slice(i + 1).trim()
  }
  return v
}

export function serializeServerConfig(original: string, values: Record<string, string>): string {
  const seen = new Set<string>()
  const out = original.split('\n').map((l) => {
    const t = l.replace(/\r$/, '')
    if (!t.trim() || t.trim().startsWith('#')) return t
    const i = t.indexOf('=')
    if (i <= 0) return t
    const k = t.slice(0, i).trim()
    seen.add(k)
    if (!(k in values)) return t
    if (values[k] === '') return `#${k}=`
    return `${k}=${values[k].replace(/[\r\n]/g, ' ')}`
  })
  for (const [k, v] of Object.entries(values)) if (!seen.has(k) && v !== '') out.push(`${k}=${v.replace(/[\r\n]/g, ' ')}`)
  return out.join('\n').replace(/\n*$/, '\n')
}

// ------------------------------------------------------------------ scripts
/** Command that starts the server inside run.sh (exec keeps the PID for stop/kill). */
export function startCommand(sw: TrSoftware, dir: string): string {
  switch (sw) {
    case 'tshock':
      return 'exec ./TShock.Server -config serverconfig.txt'
    case 'vanilla':
      return 'exec ./TerrariaServer.bin.x86_64 -config serverconfig.txt'
    case 'tmodloader':
      return `exec ./start-tModLoaderServer.sh -nosteam -config serverconfig.txt -steamworkshopfolder ${shq(dir + '/steamapps/workshop')} -tmlsavedirectory ${shq(dir + '/data')}`
  }
}

export function trEnvSh(c: TrConfig, dir: string) {
  const v = (k: string, val: string | number | boolean) => `${k}=${shq(String(val))}`
  return [
    '# Generated by SSH OS. Edit settings in the app instead of here.',
    v('GAME', 'terraria'),
    v('START_MODE', 'custom'),
    v('CUSTOM_CMD', startCommand(c.software, dir)),
    v('JAR', ''),
    v('SESSION', c.session),
    v('RESTART_ON_CRASH', c.restartOnCrash ? 1 : 0),
    v('MAX_RESTARTS', c.maxCrashRestarts),
    v('STOP_WARN', c.stopWarnSeconds),
    v('STOP_TIMEOUT', c.stopTimeout),
    v('STOP_CMD', 'exit'),
    v('BACKUP_DIR', c.backups.dir || 'backups'),
    v('BACKUP_KEEP', c.backups.keep),
    v('BACKUP_SCOPE', c.backups.scope),
    v('DOTNET_CLI_TELEMETRY_OPTOUT', 1),
    'export DOTNET_CLI_TELEMETRY_OPTOUT',
    ...(c.software === 'tshock'
      ? [
          '# TShock runs on the .NET runtime SSH OS installs into ~/.sshos/dotnet (if present)',
          '[ -x "$HOME/.sshos/dotnet/dotnet" ] && { DOTNET_ROOT="$HOME/.sshos/dotnet"; export DOTNET_ROOT; }',
        ]
      : []),
    '',
  ].join('\n')
}

/** Same control interface as the Minecraft manager (start|stop|restart|kill|status|cmd|backup). */
export const TR_CTL_SH = `#!/bin/sh
# SSH OS: Terraria server control.  Usage: ctl.sh start|stop|restart|kill|status|cmd "<command>"|backup
cd "$(dirname "$0")/.." || exit 1
. ./.sshos/env.sh
PIDF=.sshos/server.pid
running() { [ -f "$PIDF" ] && kill -0 "$(cat "$PIDF")" 2>/dev/null; }
pickmux() { if command -v tmux >/dev/null 2>&1; then echo tmux; elif command -v screen >/dev/null 2>&1; then echo screen; else echo fifo; fi; }
send() {
  case "$(cat .sshos/mux 2>/dev/null)" in
    tmux) tmux send-keys -t "$SESSION" -l -- "$1" && tmux send-keys -t "$SESSION" Enter ;;
    screen) screen -S "$SESSION" -p 0 -X stuff "$1$(printf '\\r')" ;;
    *) [ -p .sshos/stdin ] && printf '%s\\n' "$1" > .sshos/stdin ;;
  esac
}
start() {
  if running; then echo "Already running (PID $(cat $PIDF))"; return 0; fi
  M=$(pickmux); echo "$M" > .sshos/mux
  case "$M" in
    tmux) tmux kill-session -t "$SESSION" 2>/dev/null; tmux new-session -d -s "$SESSION" -x 200 -y 50 "sh .sshos/run.sh" ;;
    screen) screen -S "$SESSION" -X quit >/dev/null 2>&1; screen -dmS "$SESSION" sh .sshos/run.sh ;;
    fifo) nohup sh .sshos/run.sh >/dev/null 2>&1 & ;;
  esac
  i=0; while [ $i -lt 20 ]; do running && break; sleep 0.5; i=$((i+1)); done
  if running; then echo "Started (PID $(cat $PIDF), $M)"; else echo "Failed to start. See .sshos/console.log:"; tail -n 20 .sshos/console.log 2>/dev/null; return 1; fi
  # the server website (if set up) starts together with the server
  [ -f .sshos/web/webctl.sh ] && [ ! -f .sshos/web/disabled ] && (sh .sshos/web/webctl.sh ensure >/dev/null 2>&1 &)
}
stop() {
  touch .sshos/stop-requested
  if ! running; then echo "Not running"; return 0; fi
  W=\${1:-$STOP_WARN}
  if [ "$W" -gt 0 ] 2>/dev/null; then send "say Server is stopping in $W seconds"; sleep "$W"; fi
  send "$STOP_CMD"
  i=0; while running && [ $i -lt "$STOP_TIMEOUT" ]; do sleep 1; i=$((i+1)); done
  if running; then echo "Not responding, sending SIGTERM"; kill "$(cat $PIDF)"; sleep 10; fi
  if running; then echo "Killing"; pkill -9 -P "$(cat $PIDF)" 2>/dev/null; kill -9 "$(cat $PIDF)"; fi
  echo "Stopped"
}
case "$1" in
  start) start ;;
  stop) stop "$2" ;;
  restart) stop "$2"; sleep 2; start ;;
  kill) touch .sshos/stop-requested; if running; then pkill -9 -P "$(cat $PIDF)" 2>/dev/null; kill -9 "$(cat $PIDF)"; fi; echo "Killed" ;;
  status) if running; then echo "running $(cat $PIDF)"; else echo stopped; fi ;;
  cmd) if running; then send "$2"; else echo "Server is not running"; exit 1; fi ;;
  backup) sh .sshos/backup.sh "$2" ;;
  *) echo "usage: $0 start|stop|restart|kill|status|cmd <command>|backup [worlds|full]"; exit 2 ;;
esac
`

export const TR_BACKUP_SH = `#!/bin/sh
# SSH OS: back up a Terraria server.  Usage: backup.sh [worlds|full]
cd "$(dirname "$0")/.." || exit 1
. ./.sshos/env.sh
SCOPE=\${1:-$BACKUP_SCOPE}
mkdir -p "$BACKUP_DIR"
STAMP=$(date +%Y-%m-%d_%H-%M-%S)
OUT="$BACKUP_DIR/$SCOPE-$STAMP.tar.gz"
if [ -f .sshos/server.pid ] && kill -0 "$(cat .sshos/server.pid)" 2>/dev/null; then
  sh .sshos/ctl.sh cmd "save" >/dev/null; sleep 6
fi
if [ "$SCOPE" = full ]; then
  tar czf "$OUT" --exclude="./$BACKUP_DIR" --exclude=./steamapps --exclude=./dotnet --exclude=./logs .
else
  set --; for w in worlds data/Worlds tshock; do [ -d "$w" ] && set -- "$@" "$w"; done
  tar czf "$OUT" "$@"
fi
if [ $? -ne 0 ]; then echo "Backup failed"; rm -f "$OUT"; exit 1; fi
echo "Backup written: $OUT ($(du -h "$OUT" | cut -f1))"
ls -1t "$BACKUP_DIR"/*.tar.gz 2>/dev/null | tail -n +$((BACKUP_KEEP + 1)) | while read -r f; do rm -f "$f"; echo "Removed old backup $f"; done
`

/** cross-tool unzip: unzip, python3, or bsdtar (whichever exists) */
export const UNZIP_FN = `unz() { if command -v unzip >/dev/null 2>&1; then unzip -q -o "$1" -d "$2"; elif command -v python3 >/dev/null 2>&1; then python3 -m zipfile -e "$1" "$2"; elif command -v bsdtar >/dev/null 2>&1; then bsdtar -xf "$1" -C "$2"; else echo "Please install unzip (sudo apt install unzip)"; return 5; fi; }`

export async function writeTrManagement(hostId: string, dir: string, c: TrConfig) {
  await run(hostId, `mkdir -p ${shq(dir + '/' + MC_DIR)}`)
  const w = (name: string, text: string) => api.fs.writeText(hostId, `${dir}/${MC_DIR}/${name}`, text)
  await w(TR_FILE, JSON.stringify(c, null, 2))
  await w('env.sh', trEnvSh(c, dir))
  await w('run.sh', RUN_SH)
  await w('ctl.sh', TR_CTL_SH)
  await w('backup.sh', TR_BACKUP_SH)
  await run(hostId, `cd ${shq(dir + '/' + MC_DIR)} && chmod 755 run.sh ctl.sh backup.sh`)
  await syncCron(hostId, dir, c as unknown as McConfig)
}

export async function saveTrConfig(hostId: string, dir: string, c: TrConfig) {
  await api.fs.writeText(hostId, `${dir}/${MC_DIR}/${TR_FILE}`, JSON.stringify(c, null, 2))
  await api.fs.writeText(hostId, `${dir}/${MC_DIR}/env.sh`, trEnvSh(c, dir))
  await syncCron(hostId, dir, c as unknown as McConfig)
}

// ------------------------------------------------------------------ detection
const DETECT = `
for d in "$HOME" /opt /srv /home /var/games /mnt /data; do
  [ -d "$d" ] && find "$d" -maxdepth 4 -type f -user "$(id -u)" \\( -name TShock.Server -o -name start-tModLoaderServer.sh -o -name TerrariaServer.bin.x86_64 -o -name ${TR_FILE} \\) -not -path '*/backups/*' -not -path '*/steamapps/*' -not -path '*/.net/*' -not -path '*/.sshos/dotnet/*' -not -path '*/.local/*' 2>/dev/null
done | while read -r f; do d=$(dirname "$f"); case "$d" in */.sshos) d=$(dirname "$d");; esac; echo "$d"; done | sort -u | head -40
`

export async function detectTrDirs(hostId: string): Promise<string[]> {
  const r = await run(hostId, DETECT, 30000)
  return r.stdout.split('\n').map((s) => s.trim()).filter(Boolean)
}

const INSPECT = (dirs: string[]) => `
for d in ${dirs.map(shq).join(' ')}; do
  [ -d "$d" ] || continue  # folder removed outside SSH OS
  [ -O "$d" ] || continue  # only folders owned by this user (never run another user's scripts)
  echo "@@DIR $d"
  ls -1 "$d" 2>/dev/null | head -200
  echo "@@CFG"; cat "$d/${MC_DIR}/${TR_FILE}" 2>/dev/null
  echo "@@SC"; cat "$d/serverconfig.txt" 2>/dev/null | grep -vE '^\\s*#' | head -80
  echo "@@VER"; head -1 "$d/changelog.txt" 2>/dev/null
  echo "@@RUN"
  if [ -f "$d/${MC_DIR}/server.pid" ] && kill -0 "$(cat "$d/${MC_DIR}/server.pid")" 2>/dev/null; then echo "PID $(cat "$d/${MC_DIR}/server.pid")"; else
    for p in $(pgrep -f 'TShock|TerrariaServer|tModLoader' 2>/dev/null); do [ "$(readlink /proc/$p/cwd 2>/dev/null)" = "$d" ] && { echo "EXT $p"; break; }; done
  fi
done
`

function inferTr(files: string[]): TrSoftware {
  if (files.includes('TShock.Server')) return 'tshock'
  if (files.includes('tModLoader.dll') || files.includes('start-tModLoaderServer.sh')) return 'tmodloader'
  return 'vanilla'
}

export async function inspectTr(hostId: string, dirs: string[]): Promise<TrServer[]> {
  if (!dirs.length) return []
  const r = await run(hostId, INSPECT(dirs), 30000)
  const out: TrServer[] = []
  for (const block of r.stdout.split('@@DIR ').slice(1)) {
    const dir = block.split('\n')[0].trim()
    const sec = (a: string, b: string) => block.split(`@@${a}`)[1]?.split(`@@${b}`)[0]?.trim() ?? ''
    const files = block.split('\n').slice(1).join('\n').split('@@CFG')[0].trim().split('\n').filter(Boolean)
    const sc = parseServerConfig(sec('SC', 'VER'))
    let config: TrConfig
    let managed = false
    try {
      config = JSON.parse(sec('CFG', 'SC'))
      managed = config.game === 'terraria'
      if (!managed) throw new Error('not terraria')
    } catch {
      const software = inferTr(files)
      const ver = sec('VER', 'RUN').match(/(\d+\.\d+\.\d+(\.\d+)?)/)?.[1] ?? ''
      config = defaultTrConfig({ name: dir.split('/').filter(Boolean).pop() ?? 'terraria', software, version: ver, terraria: ver || undefined })
    }
    const runLine = block.split('@@RUN')[1]?.trim() ?? ''
    const pidM = runLine.match(/(PID|EXT) (\d+)/)
    out.push({
      game: 'terraria',
      hostId,
      dir,
      managed,
      config,
      running: !!pidM,
      pid: pidM ? +pidM[2] : undefined,
      external: pidM?.[1] === 'EXT',
      port: parseInt(sc.port ?? '7777') || 7777,
      maxPlayers: parseInt(sc.maxplayers ?? '8') || 8,
      motd: sc.motd ?? '',
      world: sc.world ?? '',
      levelName: WORLD_DIR,
      worldPaths: [WORLD_DIR],
    })
  }
  return out
}
