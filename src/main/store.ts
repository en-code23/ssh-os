import { app, safeStorage } from 'electron'
import { promises as fs, readFileSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { DEFAULT_SETTINGS, QuickCommand, ServerConfig, Settings } from '../shared/types'

interface StoredServer extends Omit<ServerConfig, 'password' | 'passphrase' | 'hasPassword' | 'hasPassphrase'> {
  secret?: string // encrypted JSON {password, passphrase}
}

interface Data {
  servers: StoredServer[]
  quickCommands: QuickCommand[]
  settings: Settings
  knownHosts: Record<string, string> // "host:port" -> sha256 fingerprint
}

const DEFAULT_COMMANDS: QuickCommand[] = [
  { id: 'qc-uptime', name: 'Uptime', command: 'uptime', icon: 'clock', color: '#30d158' },
  { id: 'qc-disk', name: 'Disk Usage', command: 'df -h', icon: 'hard-drive', color: '#0a84ff' },
  { id: 'qc-mem', name: 'Memory', command: 'free -h', icon: 'memory-stick', color: '#bf5af2' },
  { id: 'qc-update', name: 'Check Updates', command: 'apt list --upgradable 2>/dev/null | head -50', icon: 'download', color: '#ff9f0a' },
  { id: 'qc-ports', name: 'Listening Ports', command: 'ss -tulpn 2>/dev/null || netstat -tulpn', icon: 'network', color: '#64d2ff' },
  { id: 'qc-docker', name: 'Docker Containers', command: 'docker ps --format "table {{.Names}}\\t{{.Status}}\\t{{.Ports}}"', icon: 'container', color: '#0a84ff' },
  { id: 'qc-temp', name: 'CPU Temperature', command: 'vcgencmd measure_temp 2>/dev/null || cat /sys/class/thermal/thermal_zone0/temp | awk \'{printf "%.1f°C\\n", $1/1000}\'', icon: 'thermometer', color: '#ff453a' },
  { id: 'qc-failed', name: 'Failed Services', command: 'systemctl --failed --no-pager', icon: 'alert-triangle', color: '#ff375f' },
]

const file = () => join(app.getPath('userData'), 'ssh-os.json')
let data: Data

function load(): Data {
  try {
    const raw = JSON.parse(readFileSync(file(), 'utf8'))
    return {
      servers: raw.servers ?? [],
      quickCommands: raw.quickCommands ?? DEFAULT_COMMANDS,
      settings: { ...DEFAULT_SETTINGS, ...(raw.settings ?? {}) },
      knownHosts: raw.knownHosts ?? {},
    }
  } catch {
    return { servers: [], quickCommands: DEFAULT_COMMANDS, settings: { ...DEFAULT_SETTINGS }, knownHosts: {} }
  }
}

function db(): Data {
  if (!data) data = load()
  return data
}

let saveTimer: NodeJS.Timeout | null = null
function save() {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    fs.writeFile(file(), JSON.stringify(db(), null, 2), { mode: 0o600 }).catch(console.error)
  }, 100)
}

function encrypt(obj: object): string {
  const json = JSON.stringify(obj)
  if (safeStorage.isEncryptionAvailable()) return 'enc:' + safeStorage.encryptString(json).toString('base64')
  return 'raw:' + Buffer.from(json).toString('base64')
}

function decrypt(s?: string): { password?: string; passphrase?: string } {
  if (!s) return {}
  try {
    if (s.startsWith('enc:')) return JSON.parse(safeStorage.decryptString(Buffer.from(s.slice(4), 'base64')))
    if (s.startsWith('raw:')) return JSON.parse(Buffer.from(s.slice(4), 'base64').toString())
  } catch { /* ignore */ }
  return {}
}

function toPublic(s: StoredServer): ServerConfig {
  const { secret, ...rest } = s
  const sec = decrypt(secret)
  return { ...rest, hasPassword: !!sec.password, hasPassphrase: !!sec.passphrase }
}

export const store = {
  listServers(): ServerConfig[] {
    return db().servers.map(toPublic)
  },
  getServerWithSecrets(id: string): ServerConfig | undefined {
    const s = db().servers.find((x) => x.id === id)
    if (!s) return undefined
    const { secret, ...rest } = s
    return { ...rest, ...decrypt(secret) }
  },
  saveServer(input: ServerConfig & { clearPassword?: boolean }): ServerConfig {
    const d = db()
    const idx = d.servers.findIndex((x) => x.id === input.id)
    const prev = idx >= 0 ? d.servers[idx] : undefined
    const prevSec = decrypt(prev?.secret)
    const sec = {
      password: input.clearPassword ? undefined : input.password || prevSec.password,
      passphrase: input.passphrase || prevSec.passphrase,
    }
    const { password, passphrase, hasPassword, hasPassphrase, clearPassword, ...rest } = input as any
    const stored: StoredServer = {
      ...rest,
      id: input.id || randomUUID(),
      createdAt: input.createdAt || Date.now(),
      secret: sec.password || sec.passphrase ? encrypt(sec) : undefined,
    }
    if (idx >= 0) d.servers[idx] = stored
    else d.servers.push(stored)
    save()
    return toPublic(stored)
  },
  touchServer(id: string) {
    const s = db().servers.find((x) => x.id === id)
    if (s) { s.lastConnectedAt = Date.now(); save() }
  },
  deleteServer(id: string) {
    const d = db()
    d.servers = d.servers.filter((s) => s.id !== id)
    d.quickCommands = d.quickCommands.filter((c) => c.serverId !== id)
    save()
  },
  getQuickCommands(): QuickCommand[] {
    return db().quickCommands
  },
  setQuickCommands(cmds: QuickCommand[]) {
    db().quickCommands = cmds
    save()
  },
  getSettings(): Settings {
    return db().settings
  },
  setSettings(patch: Partial<Settings>): Settings {
    const d = db()
    d.settings = { ...d.settings, ...patch }
    save()
    return d.settings
  },
  getKnownHost(key: string) {
    return db().knownHosts[key]
  },
  setKnownHost(key: string, fp: string | undefined) {
    if (fp) db().knownHosts[key] = fp
    else delete db().knownHosts[key]
    save()
  },
}
