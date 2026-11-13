/**
 * Server website + world maps.
 *
 * Python tools (web.py, trworld.py, mcmap.py and the Terraria data table) are copied to
 * ~/.sshos/tools on the game server. Each server's website settings live in
 * <server>/.sshos/web/ (web.json with PBKDF2 password hashes, a self-signed certificate,
 * webctl.sh). Passwords are hashed here in the app; they never reach the server in plain text.
 */
import { api, shq } from '../api'
import { run } from '../mc/server'
import webPy from './web.py?raw'
import trworldPy from './trworld.py?raw'
import mcmapPy from './mcmap.py?raw'
import trdataJson from './trdata.json?raw'

const TOOL_FILES: Record<string, string> = { 'web.py': webPy, 'trworld.py': trworldPy, 'mcmap.py': mcmapPy, 'trdata.json': trdataJson }

function fnv(s: string) {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0
  return h.toString(16)
}
export const TOOLS_VERSION = fnv(Object.entries(TOOL_FILES).map(([k, v]) => k + v).join('\0'))

/** Copies the Python tools to ~/.sshos/tools when missing or outdated; returns that folder. */
export async function ensureTools(hostId: string): Promise<string> {
  const r = await run(hostId, `echo "$HOME"; cat "$HOME/.sshos/tools/VERSION" 2>/dev/null; echo; command -v python3 >/dev/null 2>&1 && python3 -c 'import sys; print("PY" if sys.version_info >= (3, 7) else "OLD")'`)
  const [home, ver] = r.stdout.split('\n')
  if (!/PY/.test(r.stdout)) throw new Error(/OLD/.test(r.stdout) ? 'Python 3.7 or newer is needed on the server.' : 'Python 3 is needed on the server (install the "python3" package).')
  const dir = `${home.trim()}/.sshos/tools`
  if (ver?.trim() === TOOLS_VERSION) return dir
  await run(hostId, `mkdir -p ${shq(dir + '/cache')} && chmod 700 ${shq(home.trim() + '/.sshos')} 2>/dev/null; true`)
  for (const [name, text] of Object.entries(TOOL_FILES)) await api.fs.writeText(hostId, `${dir}/${name}`, text)
  await api.fs.writeText(hostId, `${dir}/VERSION`, TOOLS_VERSION)
  return dir
}

// ------------------------------------------------------------------ website

export interface WebSettings {
  enabled: boolean
  port: number
  /** minutes between map updates */
  mapEvery: number
  /** Minecraft: blocks around spawn to draw */
  mapRadius: number
}
export const defaultWeb = (gamePort: number): WebSettings => ({ enabled: true, port: gamePort + 1000, mapEvery: 10, mapRadius: 1024 })

export interface PwRecord { salt: string; hash: string; iter: number }

const hex = (b: ArrayBuffer | Uint8Array) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('')

export async function hashPassword(pw: string): Promise<PwRecord> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveBits'])
  const iter = 200000
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, key, 256)
  return { salt: hex(salt), hash: hex(bits), iter }
}

export const WEBCTL_SH = `#!/bin/sh
# SSH OS: server website control.  Usage: webctl.sh start|ensure|stop|restart|status|fingerprint
cd "$(dirname "$0")/../.." || exit 1
W=.sshos/web; PIDF=$W/web.pid; T="$HOME/.sshos/tools"
running() { [ -f "$PIDF" ] && kill -0 "$(cat "$PIDF")" 2>/dev/null; }
cert() {
  [ -s $W/cert.pem ] && [ -s $W/key.pem ] && return 0
  command -v openssl >/dev/null 2>&1 || { echo "openssl is needed to create the HTTPS certificate (sudo apt install openssl)"; return 1; }
  SAN="DNS:localhost,IP:127.0.0.1"
  for ip in $(hostname -I 2>/dev/null); do case "$ip" in *:*) ;; *) SAN="$SAN,IP:$ip" ;; esac; done
  CN=$(hostname 2>/dev/null || echo server)
  ( umask 077
    openssl req -x509 -newkey rsa:2048 -nodes -sha256 -keyout $W/key.pem -out $W/cert.pem -days 3650 -subj "/CN=$CN" -addext "subjectAltName=$SAN" >/dev/null 2>&1 ||
    openssl req -x509 -newkey rsa:2048 -nodes -sha256 -keyout $W/key.pem -out $W/cert.pem -days 3650 -subj "/CN=$CN" >/dev/null 2>&1 )
  [ -s $W/cert.pem ] || { echo "Could not create the certificate"; return 1; }
}
start() {
  if running; then echo "running $(cat $PIDF)"; return 0; fi
  [ -f $W/web.json ] || { echo "The website is not set up"; return 1; }
  [ -f $W/disabled ] && { echo "disabled"; return 0; }
  command -v python3 >/dev/null 2>&1 || { echo "python3 is needed"; return 1; }
  [ -f "$T/web.py" ] || { echo "SSH OS tools are missing (open the server in SSH OS once)"; return 1; }
  cert || return 1
  [ -f $W/web.log ] && [ "$(wc -c < $W/web.log)" -gt 1000000 ] && tail -c 200000 $W/web.log > $W/web.log.1 && mv $W/web.log.1 $W/web.log
  nohup python3 "$T/web.py" "$PWD" >> $W/web.log 2>&1 < /dev/null &
  echo $! > $PIDF
  sleep 2
  if running; then echo "started $(cat $PIDF)"; else echo "The website failed to start:"; tail -n 15 $W/web.log; rm -f $PIDF; return 1; fi
}
stop() { if running; then kill "$(cat $PIDF)" 2>/dev/null; sleep 1; fi; rm -f $PIDF; echo stopped; }
case "$1" in
  start|ensure) start ;;
  stop) stop ;;
  restart) stop >/dev/null; start ;;
  status) if [ -f $W/disabled ]; then echo disabled; elif running; then echo "running $(cat $PIDF)"; else echo stopped; fi ;;
  fingerprint) openssl x509 -in $W/cert.pem -noout -fingerprint -sha256 2>/dev/null | sed 's/.*=//' ;;
  *) echo "usage: $0 start|stop|restart|status|fingerprint"; exit 2 ;;
esac
`

export interface WebStatus {
  configured: boolean
  state: 'running' | 'stopped' | 'disabled' | 'none'
  hasPlayer: boolean
  hasAdmin: boolean
  port?: number
  ips: string[]
  fingerprint: string
  log: string
  /** an active firewall that may block the website/game ports */
  firewall: 'ufw' | 'firewalld' | null
}

/** Terminal command that opens TCP ports in the server's firewall (needs sudo). */
export function openPortsCommand(fw: 'ufw' | 'firewalld', ports: number[]) {
  const ps = [...new Set(ports)].filter((p) => p > 0 && p < 65536)
  return fw === 'ufw'
    ? `${ps.map((p) => `sudo ufw allow ${p}/tcp`).join(' && ')} && sudo ufw status`
    : `${ps.map((p) => `sudo firewall-cmd --permanent --add-port=${p}/tcp`).join(' && ')} && sudo firewall-cmd --reload && sudo firewall-cmd --list-ports`
}

export async function websiteStatus(hostId: string, dir: string): Promise<WebStatus> {
  const w = `${dir}/.sshos/web`
  const r = await run(hostId, `cat ${shq(w + '/web.json')} 2>/dev/null; echo '@@'; [ -f ${shq(w + '/webctl.sh')} ] && sh ${shq(w + '/webctl.sh')} status; echo '@@'; hostname -I 2>/dev/null; echo '@@'; [ -f ${shq(w + '/cert.pem')} ] && sh ${shq(w + '/webctl.sh')} fingerprint; echo '@@'; tail -n 12 ${shq(w + '/web.log')} 2>/dev/null; echo '@@'; if [ "$(systemctl is-active ufw 2>/dev/null)" = active ] && grep -qs '^ENABLED=yes' /etc/ufw/ufw.conf; then echo ufw; elif [ "$(systemctl is-active firewalld 2>/dev/null)" = active ]; then echo firewalld; fi`)
  const [json, st, ips, fp, log, fw] = r.stdout.split('@@').map((x) => x.trim())
  let cfg: any = null
  try { cfg = JSON.parse(json) } catch { /* none */ }
  return {
    configured: !!cfg,
    state: !cfg ? 'none' : st.startsWith('running') ? 'running' : st.startsWith('disabled') ? 'disabled' : 'stopped',
    hasPlayer: !!cfg?.player,
    hasAdmin: !!cfg?.admin,
    port: cfg?.port,
    ips: ips.split(/\s+/).filter((x) => x && !x.includes(':')),
    fingerprint: fp,
    log,
    firewall: fw === 'ufw' || fw === 'firewalld' ? fw : null,
  }
}

/**
 * Writes the website settings and starts/stops it. Passwords left undefined keep the
 * current ones; an empty string removes that password.
 */
export async function configureWebsite(hostId: string, dir: string, o: { game: 'minecraft' | 'terraria'; title: string; web: WebSettings; playerPassword?: string; adminPassword?: string }) {
  await ensureTools(hostId)
  const w = `${dir}/.sshos/web`
  await run(hostId, `mkdir -p ${shq(w + '/cache')} && chmod 700 ${shq(w)}`)
  let cur: any = {}
  try { cur = JSON.parse(await api.fs.readText(hostId, `${w}/web.json`)) } catch { /* new */ }
  const next: any = { ...cur, game: o.game, title: o.title, port: o.web.port, mapEvery: o.web.mapEvery * 60, mapRadius: o.web.mapRadius, bind: '0.0.0.0' }
  if (o.playerPassword !== undefined) next.player = o.playerPassword ? await hashPassword(o.playerPassword) : null
  if (o.adminPassword !== undefined) next.admin = o.adminPassword ? await hashPassword(o.adminPassword) : null
  if (o.web.enabled && !next.admin) throw new Error('Choose an admin password for the website.')
  await api.fs.writeText(hostId, `${w}/web.json`, JSON.stringify(next, null, 2))
  await api.fs.writeText(hostId, `${w}/webctl.sh`, WEBCTL_SH)
  await run(hostId, `chmod 600 ${shq(w + '/web.json')}; chmod 755 ${shq(w + '/webctl.sh')}; ${o.web.enabled ? `rm -f ${shq(w + '/disabled')}` : `touch ${shq(w + '/disabled')}`}`)
  const r = await run(hostId, `sh ${shq(w + '/webctl.sh')} ${o.web.enabled ? 'restart' : 'stop'}`, 60000)
  if (o.web.enabled && !/started|running/.test(r.stdout)) throw new Error((r.stdout + r.stderr).trim().slice(-500) || 'The website did not start')
  return r.stdout.trim()
}

export async function webctl(hostId: string, dir: string, action: 'start' | 'stop' | 'restart') {
  return run(hostId, `sh ${shq(dir + '/.sshos/web/webctl.sh')} ${action}`, 60000)
}

/** Is a TCP port free on the server? (used before enabling the website) */
export async function portFree(hostId: string, port: number) {
  const r = await run(hostId, `python3 -c 'import socket,sys; s=socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1); s.bind(("0.0.0.0", int(sys.argv[1]))); print("free")' ${port} 2>/dev/null`)
  return r.stdout.includes('free')
}

// ------------------------------------------------------------------ world maps

export interface MapResult { info: any; png: string | null }

/** Renders a world on the server and returns its summary and the map as a data URL. */
export async function renderWorldMap(hostId: string, game: 'minecraft' | 'terraria', worldPath: string, opts: { scale?: number; radius?: number } = {}): Promise<MapResult> {
  const tools = await ensureTools(hostId)
  const id = Math.random().toString(36).slice(2, 10)
  const out = `${tools}/cache/${id}`
  const cmd = game === 'terraria'
    ? `python3 ${shq(tools + '/trworld.py')} ${shq(worldPath)} --json ${shq(out + '.json')} --png ${shq(out + '.png')} --scale ${opts.scale ?? 1}`
    : `python3 ${shq(tools + '/mcmap.py')} ${shq(worldPath)} --json ${shq(out + '.json')} --png ${shq(out + '.png')} --radius ${opts.radius ?? 1024}`
  const r = await run(hostId, `nice -n 10 ${cmd}`, 900000)
  try {
    if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().split('\n').slice(-3).join('\n') || 'Could not read the world')
    const info = JSON.parse(await api.fs.readText(hostId, `${out}.json`))
    const hasPng = game === 'terraria' || !!info.map
    const png = hasPng ? await api.fs.readDataUrl(hostId, `${out}.png`, 'image/png') : null
    return { info, png }
  } finally {
    run(hostId, `rm -f ${shq(out + '.json')} ${shq(out + '.png')}`).catch(() => {})
  }
}

/** Interactive Minecraft seed map (Chunkbase) in the browser. */
export function chunkbaseUrl(seed: string, x?: number, z?: number) {
  const p = new URLSearchParams({ seed, dimension: 'overworld' })
  if (x !== undefined && z !== undefined) { p.set('x', String(Math.round(x))); p.set('z', String(Math.round(z))); p.set('zoom', '0.5') }
  return `https://www.chunkbase.com/apps/seed-map#${p.toString()}`
}

export function randomSeed(game: 'minecraft' | 'terraria') {
  const a = crypto.getRandomValues(new Uint32Array(2))
  if (game === 'terraria') return String(a[0] % 2147483647)
  // signed 64-bit like Minecraft's own seeds
  const n = (BigInt(a[0]) << 32n) | BigInt(a[1])
  return (n >= 1n << 63n ? n - (1n << 64n) : n).toString()
}
