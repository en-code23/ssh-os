import { Client as FtpClient, FileInfo } from 'basic-ftp'
import type { SFTPWrapper, Stats } from 'ssh2'
import { posix } from 'path'
import { Readable, Writable } from 'stream'
import { FileEntry } from '../shared/types'

export type Progress = (bytes: number) => void

export interface RemoteFS {
  home(): Promise<string>
  list(path: string): Promise<FileEntry[]>
  stat(path: string): Promise<FileEntry>
  read(path: string, maxBytes?: number): Promise<Buffer>
  write(path: string, data: Buffer): Promise<void>
  mkdir(path: string): Promise<void>
  rename(from: string, to: string): Promise<void>
  remove(path: string, isDir: boolean): Promise<void>
  download(remote: string, local: string, onProgress?: Progress): Promise<void>
  upload(local: string, remote: string, onProgress?: Progress): Promise<void>
  chmod?(path: string, mode: number): Promise<void>
  close(): void
}

const S_IFMT = 0o170000
const S_IFDIR = 0o040000
const S_IFLNK = 0o120000

export function permString(mode: number, type: FileEntry['type']): string {
  const t = type === 'dir' ? 'd' : type === 'link' ? 'l' : '-'
  const chars = 'rwxrwxrwx'
  let s = ''
  for (let i = 0; i < 9; i++) s += mode & (1 << (8 - i)) ? chars[i] : '-'
  return t + s
}

function entryFromStats(dir: string, name: string, attrs: Stats, longname?: string): FileEntry {
  const fmt = attrs.mode & S_IFMT
  const type: FileEntry['type'] = fmt === S_IFDIR ? 'dir' : fmt === S_IFLNK ? 'link' : 'file'
  let owner: string | undefined
  let group: string | undefined
  if (longname) {
    const parts = longname.split(/\s+/)
    owner = parts[2]
    group = parts[3]
  }
  return {
    name,
    path: posix.join(dir, name),
    type,
    size: attrs.size ?? 0,
    modified: (attrs.mtime ?? 0) * 1000,
    mode: attrs.mode & 0o7777,
    permissions: permString(attrs.mode, type),
    owner: owner ?? String(attrs.uid ?? ''),
    group: group ?? String(attrs.gid ?? ''),
    hidden: name.startsWith('.'),
  }
}

const p = <T>(fn: (cb: (err: Error | null | undefined, res?: T) => void) => void) =>
  new Promise<T>((resolve, reject) => fn((err, res) => (err ? reject(err) : resolve(res as T))))

export class SftpFS implements RemoteFS {
  constructor(
    private sftp: SFTPWrapper,
    private exec?: (cmd: string) => Promise<{ code: number | null; stderr: string }>,
  ) {}

  home() {
    return p<string>((cb) => this.sftp.realpath('.', cb as any))
  }

  async list(path: string): Promise<FileEntry[]> {
    const items = await p<any[]>((cb) => this.sftp.readdir(path, cb as any))
    const out = items
      .filter((i) => i.filename !== '.' && i.filename !== '..')
      .map((i) => entryFromStats(path, i.filename, i.attrs, i.longname))
    await Promise.all(
      out
        .filter((e) => e.type === 'link')
        .map(async (e) => {
          try {
            const st = await p<Stats>((cb) => this.sftp.stat(e.path, cb as any))
            e.linkToDir = st.isDirectory()
          } catch { /* broken link */ }
        }),
    )
    return out
  }

  async stat(path: string): Promise<FileEntry> {
    const st = await p<Stats>((cb) => this.sftp.lstat(path, cb as any))
    const e = entryFromStats(posix.dirname(path), posix.basename(path) || '/', st)
    e.path = path
    if (e.type === 'link') {
      try {
        e.linkToDir = (await p<Stats>((cb) => this.sftp.stat(path, cb as any))).isDirectory()
      } catch { /* ignore */ }
    }
    return e
  }

  read(path: string, maxBytes = 20 * 1024 * 1024): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      let total = 0
      const s = this.sftp.createReadStream(path)
      s.on('data', (c: Buffer) => {
        total += c.length
        if (total > maxBytes) {
          s.destroy()
          reject(new Error(`File is larger than ${Math.round(maxBytes / 1024 / 1024)} MB`))
          return
        }
        chunks.push(c)
      })
      s.on('end', () => resolve(Buffer.concat(chunks)))
      s.on('error', reject)
    })
  }

  write(path: string, data: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
      const s = this.sftp.createWriteStream(path)
      s.on('close', () => resolve())
      s.on('error', reject)
      s.end(data)
    })
  }

  mkdir(path: string) {
    return p<void>((cb) => this.sftp.mkdir(path, cb as any))
  }

  rename(from: string, to: string) {
    return p<void>((cb) => this.sftp.rename(from, to, cb as any))
  }

  async remove(path: string, isDir: boolean): Promise<void> {
    if (!isDir) return p<void>((cb) => this.sftp.unlink(path, cb as any))
    if (this.exec) {
      const r = await this.exec(`rm -rf -- ${shq(path)}`)
      if (r.code !== 0) throw new Error(r.stderr.trim() || 'Delete failed')
      return
    }
    for (const e of await this.list(path)) await this.remove(e.path, e.type === 'dir')
    await p<void>((cb) => this.sftp.rmdir(path, cb as any))
  }

  download(remote: string, local: string, onProgress?: Progress) {
    return p<void>((cb) =>
      this.sftp.fastGet(remote, local, { step: (t) => onProgress?.(t) }, cb as any),
    )
  }

  upload(local: string, remote: string, onProgress?: Progress) {
    return p<void>((cb) =>
      this.sftp.fastPut(local, remote, { step: (t) => onProgress?.(t) }, cb as any),
    )
  }

  chmod(path: string, mode: number) {
    return p<void>((cb) => this.sftp.chmod(path, mode, cb as any))
  }

  close() {
    try { this.sftp.end() } catch { /* ignore */ }
  }
}

/** Serializes access: basic-ftp supports only one command at a time. */
export class FtpFS implements RemoteFS {
  private queue: Promise<unknown> = Promise.resolve()
  private client: FtpClient | null = null
  private homeDir = '/'

  constructor(private connectFn: () => Promise<FtpClient>) {}

  async init() {
    this.client = await this.connectFn()
    this.homeDir = await this.client.pwd()
  }

  private run<T>(fn: (c: FtpClient) => Promise<T>): Promise<T> {
    const next = this.queue.then(async () => {
      if (!this.client || this.client.closed) this.client = await this.connectFn()
      return fn(this.client)
    })
    this.queue = next.catch(() => undefined)
    return next
  }

  async home() {
    return this.homeDir
  }

  private toEntry(dir: string, f: FileInfo): FileEntry {
    const type: FileEntry['type'] = f.isDirectory ? 'dir' : f.isSymbolicLink ? 'link' : 'file'
    let mode: number | undefined
    if (f.permissions) mode = (f.permissions.user << 6) | (f.permissions.group << 3) | f.permissions.world
    return {
      name: f.name,
      path: posix.join(dir, f.name),
      type,
      linkToDir: f.isSymbolicLink ? !f.name.includes('.') : undefined,
      size: f.size,
      modified: f.modifiedAt ? f.modifiedAt.getTime() : parseFtpDate(f.rawModifiedAt),
      mode,
      permissions: mode !== undefined ? permString(mode, type) : undefined,
      owner: f.user || undefined,
      group: f.group || undefined,
      hidden: f.name.startsWith('.'),
    }
  }

  list(path: string) {
    return this.run(async (c) =>
      (await c.list(path)).filter((f) => f.name !== '.' && f.name !== '..').map((f) => this.toEntry(path, f)),
    )
  }

  async stat(path: string): Promise<FileEntry> {
    if (path === '/') return { name: '/', path: '/', type: 'dir', size: 0, modified: 0, hidden: false }
    const dir = posix.dirname(path)
    const name = posix.basename(path)
    const items = await this.list(dir)
    const found = items.find((i) => i.name === name)
    if (!found) throw new Error('No such file')
    return found
  }

  read(path: string, maxBytes = 20 * 1024 * 1024) {
    return this.run(async (c) => {
      const chunks: Buffer[] = []
      let total = 0
      const sink = new Writable({
        write(chunk, _enc, cb) {
          total += chunk.length
          if (total > maxBytes) return cb(new Error('File too large to open'))
          chunks.push(chunk)
          cb()
        },
      })
      await c.downloadTo(sink, path)
      return Buffer.concat(chunks)
    })
  }

  write(path: string, data: Buffer) {
    return this.run(async (c) => {
      await c.uploadFrom(Readable.from(data), path)
    })
  }

  mkdir(path: string) {
    return this.run(async (c) => {
      await c.send('MKD ' + (await c.protectWhitespace(path)))
    })
  }

  rename(from: string, to: string) {
    return this.run((c) => c.rename(from, to).then(() => undefined))
  }

  remove(path: string, isDir: boolean) {
    return this.run(async (c) => {
      if (isDir) {
        await c.removeDir(path)
      } else await c.remove(path)
    })
  }

  download(remote: string, local: string, onProgress?: Progress) {
    return this.run(async (c) => {
      c.trackProgress((info) => onProgress?.(info.bytes))
      try {
        await c.downloadTo(local, remote)
      } finally {
        c.trackProgress()
      }
    })
  }

  upload(local: string, remote: string, onProgress?: Progress) {
    return this.run(async (c) => {
      c.trackProgress((info) => onProgress?.(info.bytes))
      try {
        await c.uploadFrom(local, remote)
      } finally {
        c.trackProgress()
      }
    })
  }

  chmod(path: string, mode: number) {
    return this.run(async (c) => {
      await c.send(`SITE CHMOD ${mode.toString(8)} ${path}`)
    })
  }

  close() {
    this.client?.close()
  }
}

/** Unix LIST dates omit the year for recent files ("Nov 10 15:58"). */
function parseFtpDate(raw: string): number {
  if (!raw) return 0
  if (/\b\d{4}\b/.test(raw)) return Date.parse(raw) || 0
  const now = new Date()
  let t = Date.parse(`${raw} ${now.getFullYear()}`)
  if (Number.isNaN(t)) return 0
  if (t > now.getTime() + 86400000) t = Date.parse(`${raw} ${now.getFullYear() - 1}`)
  return t
}

export function shq(s: string) {
  return `'` + s.replace(/'/g, `'\\''`) + `'`
}

