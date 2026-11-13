import type {
  ConnectionState,
  ExecResult,
  FileEntry,
  QuickCommand,
  ServerConfig,
  Settings,
} from '../../../shared/types'

const c = window.api.call

export type Item = { path: string; isDir: boolean }

export interface UpdateState {
  status: 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error' | 'unsupported'
  current: string
  version?: string
  notes?: string
  progress?: number
  error?: string
  checkedAt?: number
}

export const api = {
  servers: {
    list: (): Promise<ServerConfig[]> => c('servers:list'),
    save: (s: Partial<ServerConfig> & { clearPassword?: boolean }): Promise<ServerConfig> => c('servers:save', s),
    remove: (id: string): Promise<void> => c('servers:delete', id),
    importSshConfig: (): Promise<Partial<ServerConfig>[]> => c('servers:importSshConfig'),
    forgetHostKey: (host: string, port: number): Promise<void> => c('servers:forgetHostKey', host, port),
    test: (s: Partial<ServerConfig>): Promise<boolean> => c('servers:test', s),
  },
  conn: {
    connect: (id: string, opts?: { password?: string; remember?: boolean }): Promise<ConnectionState> =>
      c('conn:connect', id, opts),
    disconnect: (id: string): Promise<void> => c('conn:disconnect', id),
    states: (): Promise<ConnectionState[]> => c('conn:states'),
  },
  fs: {
    list: (id: string, path: string): Promise<FileEntry[]> => c('fs:list', id, path),
    stat: (id: string, path: string): Promise<FileEntry> => c('fs:stat', id, path),
    readText: (id: string, path: string): Promise<string> => c('fs:readText', id, path),
    readDataUrl: (id: string, path: string, mime: string): Promise<string> => c('fs:readDataUrl', id, path, mime),
    writeText: (id: string, path: string, text: string): Promise<void> => c('fs:writeText', id, path, text),
    mkdir: (id: string, path: string): Promise<void> => c('fs:mkdir', id, path),
    rename: (id: string, from: string, to: string): Promise<void> => c('fs:rename', id, from, to),
    remove: (id: string, items: Item[]): Promise<void> => c('fs:remove', id, items),
    chmod: (id: string, path: string, mode: number): Promise<void> => c('fs:chmod', id, path, mode),
    diskFree: (id: string, path: string): Promise<number | null> => c('fs:diskFree', id, path),
    upload: (id: string, paths: string[], dir: string): Promise<void> => c('fs:upload', id, paths, dir),
    uploadDialog: (id: string, dir: string): Promise<boolean> => c('fs:uploadDialog', id, dir),
    download: (id: string, items: Item[]): Promise<string[]> => c('fs:download', id, items),
    downloadTo: (id: string, items: Item[]): Promise<string[] | null> => c('fs:downloadTo', id, items),
    openLocally: (id: string, path: string): Promise<void> => c('fs:openLocally', id, path),
    copy: (src: { serverId: string; items: Item[] }, dst: { serverId: string; dir: string }, move: boolean): Promise<void> =>
      c('fs:copy', src, dst, move),
  },
  cancelTransfer: (id: string): Promise<void> => c('transfer:cancel', id),
  exec: (id: string, cmd: string, timeout?: number): Promise<ExecResult> => c('exec', id, cmd, timeout),
  stream: {
    start: (id: string, sid: string, cmd: string): Promise<void> => c('stream:start', id, sid, cmd),
    stop: (sid: string): Promise<void> => c('stream:stop', sid),
  },
  term: {
    open: (id: string, tid: string, cols: number, rows: number, cwd?: string): Promise<void> =>
      c('term:open', id, tid, cols, rows, cwd),
    write: window.api.termWrite,
    resize: window.api.termResize,
    close: (tid: string): Promise<void> => c('term:close', tid),
  },
  settings: {
    get: (): Promise<Settings> => c('settings:get'),
    set: (p: Partial<Settings>): Promise<Settings> => c('settings:set', p),
  },
  commands: {
    get: (): Promise<QuickCommand[]> => c('commands:get'),
    set: (cmds: QuickCommand[]): Promise<void> => c('commands:set', cmds),
  },
  pickKey: (): Promise<string | null> => c('dialog:pickKey'),
  copyText: (t: string): Promise<void> => c('clipboard:write', t),
  openExternal: (url: string): Promise<void> => c('shell:openExternal', url),
  update: {
    state: (): Promise<UpdateState> => c('update:state'),
    check: (): Promise<void> => c('update:check'),
    download: (): Promise<void> => c('update:download'),
    install: (): Promise<void> => c('update:install'),
  },
  httpJson: <T = any>(url: string, opts?: { method?: string; body?: unknown; form?: Record<string, string>; text?: boolean }): Promise<T> => c('http:json', url, opts),
  httpText: (url: string): Promise<string> => c('http:json', url, { text: true }),
  appInfo: (): Promise<{ version: string; electron: string }> => c('app:info'),
  on: window.api.on,
  pathForFile: window.api.pathForFile,
}

export const isMac = window.api.platform === 'darwin'
/** Platform "command" modifier: ⌘ on macOS, Ctrl elsewhere */
export const modKey = (e: { metaKey: boolean; ctrlKey: boolean }) => (isMac ? e.metaKey : e.ctrlKey)
/** Convert mac shortcut glyphs to Windows/Linux text */
export function kbd(s: string) {
  if (isMac) return s
  return s.replace(/⇧/g, 'Shift+').replace(/⌥/g, 'Alt+').replace(/⌘/g, 'Ctrl+').replace(/⌫/g, 'Del').replace(/↩/g, 'Enter')
}

export function shq(s: string) {
  return `'` + s.replace(/'/g, `'\\''`) + `'`
}

export function uid() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36)
}
