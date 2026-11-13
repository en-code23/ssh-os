export type Protocol = 'ssh' | 'ftp' | 'ftps'
export type AuthMethod = 'password' | 'key' | 'agent'

export interface ServerConfig {
  id: string
  name: string
  protocol: Protocol
  host: string
  port: number
  username: string
  authMethod: AuthMethod
  /** Only present when sending to main; never returned to renderer. */
  password?: string
  hasPassword?: boolean
  privateKeyPath?: string
  passphrase?: string
  hasPassphrase?: boolean
  color: string
  group?: string
  defaultPath?: string
  /** FTPS: accept self-signed / untrusted certificates */
  allowUntrusted?: boolean
  createdAt: number
  lastConnectedAt?: number
}

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

export interface ConnectionState {
  serverId: string
  status: ConnectionStatus
  error?: string
  home?: string
  /** Capabilities depend on protocol */
  canExec: boolean
  fingerprint?: string
}

export interface FileEntry {
  name: string
  path: string
  type: 'file' | 'dir' | 'link'
  /** For symlinks: whether it points to a directory */
  linkToDir?: boolean
  size: number
  modified: number
  permissions?: string
  mode?: number
  owner?: string
  group?: string
  hidden: boolean
}

export interface ExecResult {
  stdout: string
  stderr: string
  code: number | null
}

export interface Transfer {
  id: string
  serverId: string
  kind: 'upload' | 'download' | 'copy'
  name: string
  total: number
  done: number
  status: 'running' | 'done' | 'error' | 'cancelled'
  error?: string
  startedAt: number
}

export interface QuickCommand {
  id: string
  name: string
  command: string
  icon?: string
  color?: string
  /** if set, only shown for this server */
  serverId?: string
}

export interface Settings {
  appearance: 'auto' | 'light' | 'dark'
  wallpaper: string
  accent: string
  dockMagnify: boolean
  dockSize: number
  showHiddenFiles: boolean
  terminalFontSize: number
  terminalTheme: 'auto' | 'dark' | 'light' | 'ocean' | 'solarized'
  /** Minecraft app in the Dock: auto = only when a server folder is detected */
  showMinecraft: 'auto' | 'always' | 'never'
  /** Terraria app in the Dock: auto = only when a server folder is detected (default: always, so new users can create their first server) */
  showTerraria: 'auto' | 'always' | 'never'
  autoCheckUpdates: boolean
  autoDownloadUpdates: boolean
}

export const DEFAULT_SETTINGS: Settings = {
  appearance: 'auto',
  wallpaper: 'sonoma',
  accent: '#0a84ff',
  dockMagnify: true,
  dockSize: 54,
  showHiddenFiles: false,
  terminalFontSize: 13,
  terminalTheme: 'auto',
  showMinecraft: 'auto',
  showTerraria: 'always',
  autoCheckUpdates: true,
  autoDownloadUpdates: true,
}

export interface StreamEvent {
  id: string
  type: 'data' | 'exit'
  data?: string
  code?: number | null
}
