import { api, shq } from '../api'
import { Software, SOFTWARE, AIKAR_FLAGS } from './apis'

// ------------------------------------------------------------------
// Types
// ------------------------------------------------------------------
export type Schedule =
  | { kind: 'off' }
  | { kind: 'daily'; time: string }
  | { kind: 'weekly'; day: number; time: string }
  | { kind: 'hours'; every: number }

export interface ContentRecord {
  source: 'modrinth' | 'hangar' | 'spigot' | 'url'
  projectId: string
  versionId?: string
  title: string
  kind: 'plugin' | 'mod' | 'datapack' | 'resourcepack'
}

export interface McConfig {
  id: string
  name: string
  software: Software
  mcVersion: string
  build?: string
  jar: string
  java: string
  xms: string
  xmx: string
  flagsPreset: 'aikar' | 'paper' | 'none'
  paperFlags?: string
  extraJvm: string
  serverArgs: string
  startMode: 'jar' | 'custom'
  customCmd: string
  session: string
  restartOnCrash: boolean
  maxCrashRestarts: number
  stopWarnSeconds: number
  stopTimeout: number
  autoStart: boolean
  restartSchedule: Schedule
  updates: {
    server: boolean
    content: boolean
    followLatest: boolean
    schedule: Schedule
    restart: 'never' | 'always'
  }
  backups: { schedule: Schedule; keep: number; scope: 'worlds' | 'full'; dir: string }
  content: Record<string, ContentRecord>
  createdAt: number
  /** server website (SSH OS 2.2+) */
  web?: import('../web/site').WebSettings
}

export interface McServer {
  hostId: string
  dir: string
  managed: boolean
  config: McConfig
  running: boolean
  pid?: number
  external?: boolean
  port: number
  levelName: string
  motd: string
  maxPlayers: number
}

export const MC_DIR = '.sshos'

export function defaultConfig(p: Partial<McConfig> & { name: string; software: Software; mcVersion: string; jar: string }): McConfig {
  return {
    id: Math.random().toString(36).slice(2, 10),
    build: undefined,
    java: 'java',
    xms: '1G',
    xmx: '2G',
    flagsPreset: 'aikar',
    extraJvm: '',
    serverArgs: p.software === 'vanilla' || p.software === 'fabric' ? 'nogui' : '--nogui',
    startMode: 'jar',
    customCmd: '',
    session: 'mc-' + p.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24),
    restartOnCrash: true,
    maxCrashRestarts: 5,
    stopWarnSeconds: 10,
    stopTimeout: 90,
    autoStart: false,
    restartSchedule: { kind: 'off' },
    updates: { server: SOFTWARE[p.software]?.autoUpdate ?? false, content: false, followLatest: false, schedule: { kind: 'off' }, restart: 'never' },
    backups: { schedule: { kind: 'off' }, keep: 7, scope: 'worlds', dir: 'backups' },
    content: {},
    createdAt: Date.now(),
    ...p,
  }
}

// ------------------------------------------------------------------
// Running scripts
// ------------------------------------------------------------------
export const sh = (script: string) => `sh -c ${shq(script)}`

export async function run(hostId: string, script: string, timeout = 60000) {
  return api.exec(hostId, sh(script), timeout)
}

// ------------------------------------------------------------------
// Detection
// ------------------------------------------------------------------
const DETECT = `
for d in "$HOME" /opt /srv /home /var/games /mnt /data; do
  [ -d "$d" ] && find "$d" -maxdepth 4 -type f -user "$(id -u)" -name server.properties -not -path '*/.*/*' -not -path '*/backups/*' 2>/dev/null
done | sed 's#/server.properties$##' | sort -u | head -40
`

export async function detectDirs(hostId: string): Promise<string[]> {
  const r = await run(hostId, DETECT, 30000)
  return r.stdout.split('\n').map((s) => s.trim()).filter(Boolean)
}

const INSPECT = (dirs: string[]) => `
for d in ${dirs.map(shq).join(' ')}; do
  [ -d "$d" ] || continue  # folder removed outside SSH OS
  [ -O "$d" ] || continue  # only folders owned by this user (never run another user's scripts)
  echo "@@DIR $d"
  ls -1 "$d" 2>/dev/null | head -200
  echo "@@CFG"; cat "$d/${MC_DIR}/mc.json" 2>/dev/null
  echo "@@PROPS"; grep -E '^(server-port|level-name|motd|max-players)=' "$d/server.properties" 2>/dev/null
  echo "@@VH"; cat "$d/version_history.json" 2>/dev/null
  echo "@@RUN"
  if [ -f "$d/${MC_DIR}/server.pid" ] && kill -0 "$(cat "$d/${MC_DIR}/server.pid")" 2>/dev/null; then echo "PID $(cat "$d/${MC_DIR}/server.pid")"; else
    for p in $(pgrep -f java 2>/dev/null); do [ "$(readlink /proc/$p/cwd 2>/dev/null)" = "$d" ] && echo "EXT $p"; done
  fi
done
`

function inferSoftware(files: string[]): { software: Software; jar: string; version: string } {
  const jars = files.filter((f) => f.endsWith('.jar'))
  const pick = (re: RegExp) => jars.find((j) => re.test(j))
  const ver = (j?: string) => j?.match(/(\d+\.\d+(?:\.\d+)?)/)?.[1] ?? ''
  let j: string | undefined
  if ((j = pick(/^paper/i))) return { software: 'paper', jar: j, version: ver(j) }
  if ((j = pick(/^purpur/i))) return { software: 'purpur', jar: j, version: ver(j) }
  if ((j = pick(/^folia/i))) return { software: 'folia', jar: j, version: ver(j) }
  if ((j = pick(/^fabric-server/i))) return { software: 'fabric', jar: j, version: j.match(/mc\.([\d.]+)-/)?.[1] ?? ver(j) }
  if (files.includes('run.sh') && files.includes('libraries')) {
    return { software: files.some((f) => /neoforge/i.test(f)) ? 'neoforge' : 'forge', jar: '', version: '' }
  }
  if ((j = pick(/^spigot/i))) return { software: 'spigot', jar: j, version: ver(j) }
  if ((j = pick(/^(minecraft_)?server/i))) return { software: 'vanilla', jar: j, version: ver(j) }
  return { software: 'custom', jar: jars[0] ?? 'server.jar', version: '' }
}

export async function inspect(hostId: string, dirs: string[]): Promise<McServer[]> {
  if (!dirs.length) return []
  const r = await run(hostId, INSPECT(dirs), 30000)
  const out: McServer[] = []
  for (const block of r.stdout.split('@@DIR ').slice(1)) {
    const dir = block.split('\n')[0].trim()
    const sec = (name: string, next: string) => block.split(`@@${name}`)[1]?.split(`@@${next}`)[0]?.trim() ?? ''
    const files = block.split('\n').slice(1).join('\n').split('@@CFG')[0].trim().split('\n').filter(Boolean)
    const cfgText = sec('CFG', 'PROPS')
    const props: Record<string, string> = {}
    for (const l of sec('PROPS', 'VH').split('\n')) {
      const i = l.indexOf('=')
      if (i > 0) props[l.slice(0, i)] = l.slice(i + 1)
    }
    const runLine = block.split('@@RUN')[1]?.trim() ?? ''
    let config: McConfig
    let managed = false
    try {
      config = JSON.parse(cfgText)
      managed = true
    } catch {
      const inf = inferSoftware(files)
      let version = inf.version
      const vh = sec('VH', 'RUN')
      const m = vh.match(/MC: ([\w.-]+)\)/)
      if (m) version = m[1]
      const name = dir.split('/').filter(Boolean).pop() ?? 'server'
      config = defaultConfig({
        name,
        software: inf.software,
        mcVersion: version,
        jar: inf.jar,
        startMode: inf.software === 'forge' || inf.software === 'neoforge' ? 'custom' : 'jar',
        customCmd: inf.software === 'forge' || inf.software === 'neoforge' ? 'sh run.sh nogui' : '',
        flagsPreset: inf.software === 'forge' || inf.software === 'neoforge' ? 'none' : 'aikar',
      })
    }
    const pidM = runLine.match(/(PID|EXT) (\d+)/)
    out.push({
      hostId,
      dir,
      managed,
      config,
      running: !!pidM,
      pid: pidM ? +pidM[2] : undefined,
      external: pidM?.[1] === 'EXT',
      port: parseInt(props['server-port'] ?? '25565') || 25565,
      levelName: props['level-name'] || 'world',
      motd: props['motd'] ?? '',
      maxPlayers: parseInt(props['max-players'] ?? '20') || 20,
    })
  }
  return out
}

// ------------------------------------------------------------------
// Scripts written into <server>/.sshos
// ------------------------------------------------------------------
function jvmFlags(c: McConfig) {
  const base = c.flagsPreset === 'aikar' ? AIKAR_FLAGS : c.flagsPreset === 'paper' ? c.paperFlags ?? AIKAR_FLAGS : ''
  return [base, c.extraJvm].filter(Boolean).join(' ')
}

export function envSh(c: McConfig) {
  const v = (k: string, val: string | number | boolean) => `${k}=${shq(String(val))}`
  return [
    '# Generated by SSH OS. Edit settings in the app instead of here.',
    v('JAVA', c.java || 'java'),
    v('JAR', c.jar),
    v('XMS', c.xms),
    v('XMX', c.xmx),
    v('JVM_FLAGS', jvmFlags(c)),
    v('SERVER_ARGS', c.serverArgs),
    v('START_MODE', c.startMode),
    v('CUSTOM_CMD', c.customCmd),
    v('SESSION', c.session),
    v('RESTART_ON_CRASH', c.restartOnCrash ? 1 : 0),
    v('MAX_RESTARTS', c.maxCrashRestarts),
    v('STOP_WARN', c.stopWarnSeconds),
    v('STOP_TIMEOUT', c.stopTimeout),
    v('BACKUP_DIR', c.backups.dir || 'backups'),
    v('BACKUP_KEEP', c.backups.keep),
    v('BACKUP_SCOPE', c.backups.scope),
    '',
  ].join('\n')
}

export const RUN_SH = `#!/bin/sh
# SSH OS: server process loop (runs inside tmux/screen or in the background)
cd "$(dirname "$0")/.." || exit 1
. ./.sshos/env.sh
MUX=$(cat .sshos/mux 2>/dev/null)
crashes=0
while :; do
  . ./.sshos/env.sh
  rm -f .sshos/stop-requested
  [ -f .sshos/console.log ] && mv -f .sshos/console.log .sshos/console.prev.log
  echo "[SSH OS] Starting server at $(date)" > .sshos/console.log
  if [ "$MUX" = fifo ]; then
    [ -p .sshos/stdin ] || { rm -f .sshos/stdin; mkfifo .sshos/stdin; }
    exec 3<>.sshos/stdin
    IN=3
  else
    IN=0
  fi
  if [ "$START_MODE" = custom ]; then
    sh -c 'echo $$ > .sshos/server.pid; exec sh -c "$1" <&'$IN sh "$CUSTOM_CMD" 2>&1 | tee -a .sshos/console.log
  else
    # shellcheck disable=SC2086
    sh -c 'echo $$ > .sshos/server.pid; J="$1"; shift; exec "$J" "$@" <&'$IN sh "$JAVA" -Xms"$XMS" -Xmx"$XMX" $JVM_FLAGS -jar "$JAR" $SERVER_ARGS 2>&1 | tee -a .sshos/console.log
  fi
  rm -f .sshos/server.pid
  if [ -f .sshos/stop-requested ] || [ "$RESTART_ON_CRASH" != 1 ]; then break; fi
  crashes=$((crashes + 1))
  if [ "$crashes" -gt "$MAX_RESTARTS" ]; then
    echo "[SSH OS] Server crashed $crashes times, giving up." | tee -a .sshos/console.log
    break
  fi
  echo "[SSH OS] Server stopped unexpectedly. Restarting in 10 seconds ($crashes/$MAX_RESTARTS)…" | tee -a .sshos/console.log
  sleep 10
done
`

export const CTL_SH = `#!/bin/sh
# SSH OS: Minecraft server control.  Usage: ctl.sh start|stop|restart|kill|status|cmd "<command>"|backup
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
  if [ "$START_MODE" != custom ] && [ ! -f "$JAR" ]; then echo "Server jar '$JAR' not found"; return 1; fi
  if ! grep -qs 'eula=true' eula.txt; then echo "EULA not accepted (eula.txt)"; return 1; fi
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
  if [ "\${1:-$STOP_WARN}" -gt 0 ] 2>/dev/null; then
    send "say Server is stopping in \${1:-$STOP_WARN} seconds"; sleep "\${1:-$STOP_WARN}"
  fi
  send "stop"
  i=0; while running && [ $i -lt "$STOP_TIMEOUT" ]; do sleep 1; i=$((i+1)); done
  if running; then echo "Not responding, sending SIGTERM"; kill "$(cat $PIDF)"; sleep 15; fi
  if running; then echo "Killing"; kill -9 "$(cat $PIDF)"; fi
  echo "Stopped"
}
case "$1" in
  start) start ;;
  stop) stop "$2" ;;
  restart) stop "$2"; sleep 2; start ;;
  kill) touch .sshos/stop-requested; running && kill -9 "$(cat $PIDF)"; echo "Killed" ;;
  status) if running; then echo "running $(cat $PIDF)"; else echo stopped; fi ;;
  cmd) if running; then send "$2"; else echo "Server is not running"; exit 1; fi ;;
  backup) sh .sshos/backup.sh "$2" ;;
  *) echo "usage: $0 start|stop|restart|kill|status|cmd <command>|backup [worlds|full]"; exit 2 ;;
esac
`

export const BACKUP_SH = `#!/bin/sh
# SSH OS: backup the server.  Usage: backup.sh [worlds|full]
cd "$(dirname "$0")/.." || exit 1
. ./.sshos/env.sh
SCOPE=\${1:-$BACKUP_SCOPE}
mkdir -p "$BACKUP_DIR"
LEVEL=$(grep -E '^level-name=' server.properties | cut -d= -f2-); LEVEL=\${LEVEL:-world}
STAMP=$(date +%Y-%m-%d_%H-%M-%S)
OUT="$BACKUP_DIR/$SCOPE-$STAMP.tar.gz"
live=0
if [ -f .sshos/server.pid ] && kill -0 "$(cat .sshos/server.pid)" 2>/dev/null; then
  live=1; sh .sshos/ctl.sh cmd "save-off"; sh .sshos/ctl.sh cmd "save-all flush"; sleep 8
fi
if [ "$SCOPE" = full ]; then
  tar czf "$OUT" --exclude="./$BACKUP_DIR" --exclude=./.sshos/old-jars --exclude=./.sshos/old-content --exclude=./cache --exclude=./logs .
else
  set --; for w in "$LEVEL" "\${LEVEL}_nether" "\${LEVEL}_the_end"; do [ -d "$w" ] && set -- "$@" "$w"; done
  tar czf "$OUT" "$@"
fi
rc=$?
[ $live = 1 ] && sh .sshos/ctl.sh cmd "save-on"
if [ $rc -ne 0 ]; then echo "Backup failed"; rm -f "$OUT"; exit 1; fi
echo "Backup written: $OUT ($(du -h "$OUT" | cut -f1))"
# retention
ls -1t "$BACKUP_DIR"/*.tar.gz 2>/dev/null | tail -n +$((BACKUP_KEEP + 1)) | while read -r f; do rm -f "$f"; echo "Removed old backup $f"; done
`

export const UPDATE_PY = `#!/usr/bin/env python3
"""SSH OS: updates the server jar and Modrinth/Hangar/Spigot content.
Usage: update.py [--dry-run] [--json] [--server-only] [--content-only] [--force]"""
import hashlib, json, os, shutil, subprocess, sys, time, urllib.request, urllib.error

UA = "ssh-os/1.0 (minecraft server manager)"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)
args = set(sys.argv[1:])
DRY = "--dry-run" in args
OUT_JSON = "--json" in args
cfg_path = os.path.join(".sshos", "mc.json")
cfg = json.load(open(cfg_path))
result = {"server": None, "content": [], "errors": []}

def log(*a):
    print("[update]", *a, flush=True)

def get(url, data=None):
    req = urllib.request.Request(url, data=json.dumps(data).encode() if data is not None else None,
                                 headers={"User-Agent": UA, "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode())

def safe_name(name):
    base = os.path.basename(str(name).replace("\\\\", "/"))
    base = "".join(ch if ch.isalnum() or ch in "._+-" else "_" for ch in base).lstrip(".")
    if not base:
        raise Exception("Refusing unsafe file name: %r" % name)
    return base

def inside(directory, name):
    dest = os.path.realpath(os.path.join(directory, safe_name(name)))
    if not dest.startswith(os.path.realpath(directory) + os.sep):
        raise Exception("Refusing to write outside %s" % directory)
    return dest

def download(url, dest, sha1=None, sha256=None):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    tmp = dest + ".part"
    with urllib.request.urlopen(req, timeout=120) as r, open(tmp, "wb") as f:
        shutil.copyfileobj(r, f)
    data = open(tmp, "rb").read()
    if sha1 and hashlib.sha1(data).hexdigest() != sha1:
        os.remove(tmp); raise Exception("SHA-1 mismatch for " + url)
    if sha256 and hashlib.sha256(data).hexdigest() != sha256:
        os.remove(tmp); raise Exception("SHA-256 mismatch for " + url)
    os.replace(tmp, dest)

def java_major():
    try:
        out = subprocess.run([cfg.get("java") or "java", "-version"], capture_output=True, text=True).stderr
        v = out.split('"')[1]
        return int(v.split(".")[1]) if v.startswith("1.") else int(v.split(".")[0].split("-")[0])
    except Exception:
        return 0

def stable(v):
    return not any(t in v for t in ("-", "pre", "rc", "snapshot", "w"))

def latest_server():
    sw, ver = cfg["software"], cfg["mcVersion"]
    if sw in ("paper", "folia"):
        base = "https://fill.papermc.io/v3/projects/" + sw
        if cfg["updates"].get("followLatest"):
            p = get(base)
            ver = next(v for group in p["versions"].values() for v in group if stable(v))
        b = get(base + "/versions/" + ver + "/builds/latest")
        info = get(base + "/versions/" + ver)
        d = b["downloads"]["server:default"]
        return dict(version=ver, build=str(b["id"]), url=d["url"], name=d["name"], sha256=d["checksums"].get("sha256"),
                    java=info.get("version", {}).get("java", {}).get("version", {}).get("minimum", 0))
    if sw == "purpur":
        if cfg["updates"].get("followLatest"):
            ver = get("https://api.purpurmc.org/v2/purpur")["metadata"]["current"]
        b = get("https://api.purpurmc.org/v2/purpur/" + ver)["builds"]["latest"]
        return dict(version=ver, build=str(b), url="https://api.purpurmc.org/v2/purpur/%s/%s/download" % (ver, b), name="purpur-%s-%s.jar" % (ver, b), java=0)
    if sw == "fabric":
        if cfg["updates"].get("followLatest"):
            ver = next(v["version"] for v in get("https://meta.fabricmc.net/v2/versions/game") if v["stable"])
        loader = next(l["loader"]["version"] for l in get("https://meta.fabricmc.net/v2/versions/loader/" + ver) if l["loader"]["stable"])
        inst = next(i["version"] for i in get("https://meta.fabricmc.net/v2/versions/installer") if i["stable"])
        return dict(version=ver, build=loader + "/" + inst, url="https://meta.fabricmc.net/v2/versions/loader/%s/%s/%s/server/jar" % (ver, loader, inst),
                    name="fabric-server-mc.%s-loader.%s-launcher.%s.jar" % (ver, loader, inst), java=0)
    if sw == "vanilla":
        m = get("https://piston-meta.mojang.com/mc/game/version_manifest_v2.json")
        if cfg["updates"].get("followLatest"):
            ver = m["latest"]["release"]
        v = next(x for x in m["versions"] if x["id"] == ver)
        j = get(v["url"])
        return dict(version=ver, build=ver, url=j["downloads"]["server"]["url"], name="minecraft_server.%s.jar" % ver,
                    sha1=j["downloads"]["server"]["sha1"], java=j.get("javaVersion", {}).get("majorVersion", 0))
    return None

def update_server():
    if cfg["software"] not in ("paper", "folia", "purpur", "fabric", "vanilla"):
        log("Server software", cfg["software"], "cannot be updated automatically"); return False
    lt = latest_server()
    cur = (cfg.get("mcVersion"), str(cfg.get("build")))
    if (lt["version"], lt["build"]) == cur and os.path.exists(cfg["jar"]) and "--force" not in args:
        log("Server is up to date:", cfg["software"], lt["version"], "build", lt["build"])
        result["server"] = {"current": cur[1], "latest": lt["build"], "version": lt["version"], "update": False}
        return False
    need = lt.get("java") or 0
    have = java_major()
    result["server"] = {"current": cur[1], "latest": lt["build"], "version": lt["version"], "fromVersion": cur[0], "update": True}
    if need and have and have < need:
        msg = "New build needs Java %s but server has Java %s. Install a newer Java in SSH OS." % (need, have)
        log(msg); result["errors"].append(msg); return False
    log("Update available: %s %s build %s -> %s build %s" % (cfg["software"], cur[0], cur[1], lt["version"], lt["build"]))
    if DRY:
        return False
    os.makedirs(".sshos/old-jars", exist_ok=True)
    lt["name"] = safe_name(lt["name"])
    download(lt["url"], inside(".", lt["name"]), sha1=lt.get("sha1"), sha256=lt.get("sha256"))
    if cfg["jar"] and os.path.exists(cfg["jar"]) and cfg["jar"] != lt["name"]:
        shutil.move(cfg["jar"], os.path.join(".sshos/old-jars", os.path.basename(cfg["jar"])))
        olds = sorted(os.listdir(".sshos/old-jars"), key=lambda f: os.path.getmtime(os.path.join(".sshos/old-jars", f)))
        for f in olds[:-3]:
            os.remove(os.path.join(".sshos/old-jars", f))
    cfg["jar"], cfg["mcVersion"], cfg["build"] = lt["name"], lt["version"], lt["build"]
    log("Installed", lt["name"])
    return True

def content_dirs():
    level = "world"
    try:
        for l in open("server.properties"):
            if l.startswith("level-name="):
                level = l.split("=", 1)[1].strip() or "world"
    except Exception:
        pass
    return [("plugins", "plugin"), ("mods", "mod"), (os.path.join(level, "datapacks"), "datapack")]

def update_content():
    changed = False
    loaders = {"paper": ["paper", "spigot", "bukkit"], "purpur": ["purpur", "paper", "spigot", "bukkit"], "folia": ["folia"],
               "fabric": ["fabric"], "forge": ["forge"], "neoforge": ["neoforge"]}.get(cfg["software"], ["paper", "spigot", "bukkit"])
    files = {}
    for d, kind in content_dirs():
        if not os.path.isdir(d):
            continue
        for f in os.listdir(d):
            if f.endswith(".jar") or (kind == "datapack" and f.endswith(".zip")):
                p = os.path.join(d, f)
                files[hashlib.sha1(open(p, "rb").read()).hexdigest()] = (p, kind)
    if not files:
        log("No plugins or mods to check"); return False
    try:
        upd = get("https://api.modrinth.com/v2/version_files/update",
                  {"hashes": list(files), "algorithm": "sha1", "loaders": loaders + ["datapack"], "game_versions": [cfg["mcVersion"]]})
    except Exception as e:
        log("Modrinth check failed:", e); result["errors"].append(str(e)); upd = {}
    for h, v in upd.items():
        path, kind = files[h]
        f = next((x for x in v["files"] if x.get("primary")), v["files"][0])
        if f["hashes"]["sha1"] == h:
            continue
        f["filename"] = safe_name(f["filename"])
        entry = {"file": path, "name": os.path.basename(path), "to": f["filename"], "version": v["version_number"], "source": "modrinth"}
        result["content"].append(entry)
        log("Update: %s -> %s (%s)" % (entry["name"], f["filename"], v["version_number"]))
        if DRY:
            continue
        try:
            d = os.path.dirname(path)
            dest = inside(d, f["filename"])
            download(f["url"], dest, sha1=f["hashes"]["sha1"])
            if dest != path:
                os.makedirs(".sshos/old-content", exist_ok=True)
                shutil.move(path, os.path.join(".sshos/old-content", os.path.basename(path)))
            rec = cfg.get("content", {}).pop(os.path.basename(path), None)
            if rec:
                rec["versionId"] = v["id"]; cfg["content"][f["filename"]] = rec
            changed = True
        except Exception as e:
            log("Failed:", e); result["errors"].append(str(e))
    # Hangar / Spigot content recorded by SSH OS
    for name, rec in list(cfg.get("content", {}).items()):
        try:
            if rec.get("source") == "hangar":
                slug = rec["projectId"].split("/")[-1]
                vs = get("https://hangar.papermc.io/api/v1/projects/%s/versions?limit=1&platform=PAPER&channel=Release" % slug)["result"]
                if not vs or str(vs[0]["id"]) == str(rec.get("versionId")):
                    continue
                dl = vs[0]["downloads"].get("PAPER", {})
                if not dl.get("downloadUrl"):
                    continue
                result["content"].append({"file": "plugins/" + name, "name": name, "to": name, "version": vs[0]["name"], "source": "hangar"})
                log("Update: %s -> %s" % (name, vs[0]["name"]))
                if not DRY:
                    download(dl["downloadUrl"], inside("plugins", name), sha256=(dl.get("fileInfo") or {}).get("sha256Hash"))
                    rec["versionId"] = str(vs[0]["id"]); changed = True
            elif rec.get("source") == "spigot":
                v = get("https://api.spiget.org/v2/resources/%s/versions/latest" % rec["projectId"])
                if str(v["id"]) == str(rec.get("versionId")):
                    continue
                result["content"].append({"file": "plugins/" + name, "name": name, "to": name, "version": v["name"], "source": "spigot"})
                log("Update: %s -> %s" % (name, v["name"]))
                if not DRY:
                    download("https://api.spiget.org/v2/resources/%s/download" % rec["projectId"], inside("plugins", name))
                    rec["versionId"] = str(v["id"]); changed = True
        except Exception as e:
            log("Could not check", name, "-", e)
    if not result["content"]:
        log("All content is up to date")
    return changed

def running():
    try:
        os.kill(int(open(".sshos/server.pid").read().strip()), 0); return True
    except Exception:
        return False

changed = False
try:
    if "--content-only" not in args and (cfg["updates"].get("server") or "--force" in args or "--server-only" in args or DRY):
        changed |= update_server()
except Exception as e:
    log("Server update failed:", e); result["errors"].append(str(e))
try:
    if "--server-only" not in args and (cfg["updates"].get("content") or "--content-only" in args or DRY):
        changed |= update_content()
except Exception as e:
    log("Content update failed:", e); result["errors"].append(str(e))

if changed and not DRY:
    json.dump(cfg, open(cfg_path + ".tmp", "w"), indent=2); os.replace(cfg_path + ".tmp", cfg_path)
    subprocess.run(["sh", ".sshos/write-env.sh"]) if os.path.exists(".sshos/write-env.sh") else None
    if running():
        if cfg["updates"].get("restart") == "always" and "--no-restart" not in args:
            log("Restarting server to apply updates")
            subprocess.run(["sh", ".sshos/ctl.sh", "restart", "30"])
        else:
            log("Updates will apply on the next restart")
if OUT_JSON:
    print("@@RESULT " + json.dumps(result))
`

/** Rewrites env.sh JAR line from mc.json after an unattended update. */
export const WRITE_ENV_SH = String.raw`#!/bin/sh
cd "$(dirname "$0")/.." || exit 1
python3 - <<'EOF'
import json, re
c = json.load(open(".sshos/mc.json"))
jar = c["jar"].replace("'", "'\''")
s = open(".sshos/env.sh").read()
s = re.sub(r"^JAR=.*$", lambda m: "JAR='" + jar + "'", s, flags=re.M)
open(".sshos/env.sh", "w").write(s)
EOF
`

/** Server List Ping to localhost: players, version, MOTD. */
export const SLP_PY = (port: number) => `python3 - <<'EOF'
import socket, struct, json
def vi(n):
    out=b''
    while True:
        b=n&0x7F; n>>=7
        out+=bytes([b|(0x80 if n else 0)])
        if not n: return out
def rvi(s):
    n=0
    for i in range(5):
        b=s.recv(1)[0]; n|=(b&0x7F)<<7*i
        if not b&0x80: return n
try:
    s=socket.create_connection(("127.0.0.1",${port}),timeout=3)
    h=b'\\x00'+vi(767)+vi(9)+b'127.0.0.1'+struct.pack('>H',${port})+vi(1)
    s.sendall(vi(len(h))+h+b'\\x01\\x00')
    rvi(s); rvi(s); l=rvi(s); d=b''
    while len(d)<l: d+=s.recv(l-len(d))
    print(d.decode())
except Exception as e:
    print(json.dumps({"error":str(e)}))
EOF`

// ------------------------------------------------------------------
// Install / save management files
// ------------------------------------------------------------------
export async function writeManagement(hostId: string, dir: string, c: McConfig) {
  await run(hostId, `mkdir -p ${shq(dir + '/' + MC_DIR)}`)
  const w = (name: string, text: string) => api.fs.writeText(hostId, `${dir}/${MC_DIR}/${name}`, text)
  await w('mc.json', JSON.stringify(c, null, 2))
  await w('env.sh', envSh(c))
  await w('run.sh', RUN_SH)
  await w('ctl.sh', CTL_SH)
  await w('backup.sh', BACKUP_SH)
  await w('update.py', UPDATE_PY)
  await w('write-env.sh', WRITE_ENV_SH)
  await run(hostId, `cd ${shq(dir + '/' + MC_DIR)} && chmod 755 run.sh ctl.sh backup.sh update.py write-env.sh`)
  await syncCron(hostId, dir, c)
}

export async function saveConfig(hostId: string, dir: string, c: McConfig) {
  await api.fs.writeText(hostId, `${dir}/${MC_DIR}/mc.json`, JSON.stringify(c, null, 2))
  await api.fs.writeText(hostId, `${dir}/${MC_DIR}/env.sh`, envSh(c))
  await syncCron(hostId, dir, c)
}

export async function ctl(hostId: string, dir: string, action: string, arg?: string, timeout = 180000) {
  return run(hostId, `sh ${shq(dir + '/' + MC_DIR + '/ctl.sh')} ${action}${arg !== undefined ? ' ' + shq(arg) : ''}`, timeout)
}

// ------------------------------------------------------------------
// Cron
// ------------------------------------------------------------------
function cronExpr(s: Schedule): string | null {
  if (s.kind === 'off') return null
  if (s.kind === 'hours') return `0 */${Math.max(1, Math.min(23, s.every))} * * *`
  const [h, m] = s.time.split(':').map((x) => parseInt(x) || 0)
  if (s.kind === 'daily') return `${m} ${h} * * *`
  return `${m} ${h} * * ${s.day}`
}

export function describeSchedule(s: Schedule) {
  if (s.kind === 'off') return 'Off'
  if (s.kind === 'hours') return `Every ${s.every} hour${s.every === 1 ? '' : 's'}`
  if (s.kind === 'daily') return `Daily at ${s.time}`
  return `${['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'][s.day]} at ${s.time}`
}

export async function syncCron(hostId: string, dir: string, c: McConfig) {
  const tag = `# sshos-mc:${c.id}`
  const d = shq(dir)
  const lines: string[] = []
  if (c.autoStart) lines.push(`@reboot sleep 20 && sh ${d}/.sshos/ctl.sh start >/dev/null 2>&1 ${tag}`)
  const u = cronExpr(c.updates.schedule)
  if (u && (c.updates.server || c.updates.content)) lines.push(`${u} cd ${d} && python3 .sshos/update.py >> .sshos/update.log 2>&1 ${tag}`)
  const b = cronExpr(c.backups.schedule)
  if (b) lines.push(`${b} sh ${d}/.sshos/backup.sh >> ${d}/.sshos/backup.log 2>&1 ${tag}`)
  const r = cronExpr(c.restartSchedule)
  if (r) lines.push(`${r} [ "$(sh ${d}/.sshos/ctl.sh status | cut -c1-7)" = running ] && sh ${d}/.sshos/ctl.sh restart 60 >/dev/null 2>&1 ${tag}`)
  if (c.web?.enabled) {
    // website: start on boot and restart within 5 minutes if it ever stops
    lines.push(`@reboot sleep 30 && sh ${d}/.sshos/web/webctl.sh ensure >/dev/null 2>&1 ${tag}`)
    lines.push(`*/5 * * * * sh ${d}/.sshos/web/webctl.sh ensure >/dev/null 2>&1 ${tag}`)
  }
  const script = `
command -v crontab >/dev/null 2>&1 || { echo "NO_CRON"; exit 0; }
( crontab -l 2>/dev/null | grep -vF ${shq(tag)} ; ${lines.map((l) => `printf '%s\\n' ${shq(l)}`).join(' ; ') || 'true'} ) | crontab -
`
  const res = await run(hostId, script)
  if (res.stdout.includes('NO_CRON') && lines.length) throw new Error('cron is not installed on this server, so schedules and start-on-boot are unavailable (install the "cron" package).')
}

export async function removeCron(hostId: string, id: string) {
  await run(hostId, `command -v crontab >/dev/null && crontab -l 2>/dev/null | grep -vF ${shq('# sshos-mc:' + id)} | crontab - ; true`)
}

// ------------------------------------------------------------------
// Java
// ------------------------------------------------------------------
export interface JavaInstall { path: string; major: number; label: string }

export async function listJava(hostId: string): Promise<{ installs: JavaInstall[]; arch: string; memTotal: number; cpus: number; python: boolean; mux: string; cron: boolean }> {
  const r = await run(
    hostId,
    `uname -m; echo "@@"; grep MemTotal /proc/meminfo | awk '{print $2}'; echo "@@"; nproc 2>/dev/null || echo 1; echo "@@"
command -v python3 >/dev/null && echo yes || echo no; echo "@@"
(command -v tmux >/dev/null && echo tmux) || (command -v screen >/dev/null && echo screen) || echo fifo; echo "@@"
command -v crontab >/dev/null && echo yes || echo no; echo "@@"
for j in "$(command -v java 2>/dev/null)" $HOME/.sshos/java/*/bin/java /usr/lib/jvm/*/bin/java /opt/java/*/bin/java; do
  [ -x "$j" ] || continue
  v=$("$j" -version 2>&1 | head -1)
  echo "$j|$v"
done`,
  )
  const [arch, mem, cpus, py, mux, cron, javas] = r.stdout.split('@@').map((s) => s.trim())
  const seen = new Set<string>()
  const installs: JavaInstall[] = []
  for (const l of (javas ?? '').split('\n').filter(Boolean)) {
    const [path, v] = l.split('|')
    const m = v?.match(/"(\d+)(?:\.(\d+))?/)
    if (!m) continue
    const major = m[1] === '1' ? parseInt(m[2]) : parseInt(m[1])
    const key = `${major}:${v}`
    if (seen.has(path) || seen.has(key)) continue
    seen.add(path)
    seen.add(key)
    installs.push({ path, major, label: v.replace(/^.*version /, '').trim() })
  }
  return { installs, arch, memTotal: (parseInt(mem) || 0) * 1024, cpus: parseInt(cpus) || 1, python: py === 'yes', mux, cron: cron === 'yes' }
}

export function installJavaScript(major: number, url: string) {
  const dest = `$HOME/.sshos/java/temurin-${major}-jre`
  return `set -e
DEST="${dest}"
echo "Installing Eclipse Temurin JRE ${major} into $DEST"
rm -rf "$DEST.tmp"; mkdir -p "$DEST.tmp"
if command -v curl >/dev/null; then curl -fL --progress-bar ${shq(url)} -o "$DEST.tmp/jre.tar.gz"; else wget -O "$DEST.tmp/jre.tar.gz" ${shq(url)}; fi
tar xzf "$DEST.tmp/jre.tar.gz" -C "$DEST.tmp" --strip-components=1
rm -f "$DEST.tmp/jre.tar.gz"; rm -rf "$DEST"; mv "$DEST.tmp" "$DEST"
"$DEST/bin/java" -version
echo "JAVA_PATH=$DEST/bin/java"`
}

/** Make a remote-supplied file name safe: no paths, no shell metacharacters. */
export function safeFileName(name: string, fallback = 'download.jar') {
  const base = (name.split(/[\\/]/).pop() ?? '').replace(/[^\w.+-]/g, '_').replace(/^\.+/, '')
  return base && base !== '.' && base !== '..' ? base.slice(0, 120) : fallback
}

/** shell snippet that downloads url to file using curl or wget */
export function fetchCmd(url: string, out: string) {
  return `if command -v curl >/dev/null 2>&1; then curl -fL --retry 2 -A 'ssh-os/1.0' -o ${shq(out)} ${shq(url)}; else wget -q -U 'ssh-os/1.0' -O ${shq(out)} ${shq(url)}; fi`
}

export function parseSize(s: string): number {
  const m = s.trim().match(/^(\d+(?:\.\d+)?)([KMG]?)/i)
  if (!m) return 0
  const n = parseFloat(m[1])
  const u = m[2].toUpperCase()
  return n * (u === 'G' ? 1024 : u === 'M' ? 1 : u === 'K' ? 1 / 1024 : 1 / 1024 / 1024)
}
