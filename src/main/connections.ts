import { Client, ClientChannel, ConnectConfig } from 'ssh2'
import { Client as FtpClient } from 'basic-ftp'
import { createHash } from 'crypto'
import { readFileSync } from 'fs'
import { homedir } from 'os'
import { StringDecoder } from 'string_decoder'
import { ConnectionState, ExecResult, ServerConfig } from '../shared/types'
import { FtpFS, RemoteFS, SftpFS } from './remote-fs'
import { store } from './store'

type Emit = (channel: string, payload: unknown) => void
let emit: Emit = () => {}
export function setEmitter(fn: Emit) {
  emit = fn
}

interface Session {
  server: ServerConfig
  state: ConnectionState
  ssh?: Client
  fs?: RemoteFS
}

const sessions = new Map<string, Session>()
const terminals = new Map<string, { serverId: string; channel: ClientChannel }>()
const streams = new Map<string, { serverId: string; channel: ClientChannel }>()

function setState(s: Session, patch: Partial<ConnectionState>) {
  s.state = { ...s.state, ...patch }
  emit('conn:state', s.state)
}

export function getStates(): ConnectionState[] {
  return [...sessions.values()].map((s) => s.state)
}

function expandHome(p: string) {
  return p.startsWith('~') ? homedir() + p.slice(1) : p
}

export class AuthRequiredError extends Error {
  constructor() {
    super('NEED_PASSWORD')
  }
}

function connectSSH(server: ServerConfig, password?: string): Promise<{ client: Client; fingerprint: string }> {
  return new Promise((resolve, reject) => {
    const client = new Client()
    const hostKey = `${server.host}:${server.port}`
    let fingerprint = ''
    let mismatch = false

    const cfg: ConnectConfig = {
      host: server.host,
      port: server.port,
      username: server.username,
      readyTimeout: 15000,
      keepaliveInterval: 15000,
      keepaliveCountMax: 4,
      tryKeyboard: true,
      hostVerifier: (key: Buffer) => {
        fingerprint = 'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '')
        const known = store.getKnownHost(hostKey)
        if (known && known !== fingerprint) {
          mismatch = true
          return false
        }
        if (!known) store.setKnownHost(hostKey, fingerprint)
        return true
      },
    }

    if (server.authMethod === 'password') {
      if (!password) return reject(new AuthRequiredError())
      cfg.password = password
    } else if (server.authMethod === 'key') {
      if (!server.privateKeyPath) return reject(new Error('No private key file selected'))
      try {
        cfg.privateKey = readFileSync(expandHome(server.privateKeyPath))
      } catch (e: any) {
        return reject(new Error(`Cannot read key file: ${e.message}`))
      }
      if (server.passphrase || password) cfg.passphrase = server.passphrase || password
    } else {
      cfg.agent = process.env.SSH_AUTH_SOCK || (process.platform === 'win32' ? '\\\\.\\pipe\\openssh-ssh-agent' : undefined)
      if (!cfg.agent) return reject(new Error('No SSH agent available (SSH_AUTH_SOCK not set)'))
    }

    client.on('keyboard-interactive', (_n, _i, _l, prompts, finish) => {
      finish(prompts.map(() => password ?? ''))
    })
    client.on('ready', () => resolve({ client, fingerprint }))
    client.on('error', (err: any) => {
      if (mismatch) {
        return reject(
          new Error(
            `HOST KEY MISMATCH for ${hostKey}. The server's identity changed (got ${fingerprint}). ` +
              `If this is expected, forget the host key in the server settings.`,
          ),
        )
      }
      if (err.level === 'client-authentication') {
        if (server.authMethod === 'password') return reject(new Error('Authentication failed: wrong username or password'))
        if (server.authMethod === 'key' && /passphrase|encrypted/i.test(err.message)) return reject(new AuthRequiredError())
      }
      if (/encrypted private key/i.test(err.message) && !password) return reject(new AuthRequiredError())
      reject(err)
    })
    try {
      client.connect(cfg)
    } catch (e: any) {
      if (/passphrase|encrypted/i.test(e.message)) reject(new AuthRequiredError())
      else reject(e)
    }
  })
}

async function connectFTP(server: ServerConfig, password?: string): Promise<FtpClient> {
  const c = new FtpClient(20000)
  await c.access({
    host: server.host,
    port: server.port,
    user: server.username || 'anonymous',
    password: password ?? (server.username ? '' : 'anonymous@'),
    secure: server.protocol === 'ftps',
    secureOptions: server.allowUntrusted ? { rejectUnauthorized: false } : undefined,
  })
  return c
}

export async function connect(serverId: string, opts: { password?: string; remember?: boolean } = {}) {
  const server = store.getServerWithSecrets(serverId)
  if (!server) throw new Error('Unknown server')
  const existing = sessions.get(serverId)
  if (existing && existing.state.status === 'connected') return existing.state
  if (existing) await disconnect(serverId)

  const password = opts.password || server.password
  const session: Session = {
    server,
    state: { serverId, status: 'connecting', canExec: server.protocol === 'ssh' },
  }
  sessions.set(serverId, session)
  emit('conn:state', session.state)

  try {
    if (server.protocol === 'ssh') {
      const { client, fingerprint } = await connectSSH(server, password)
      session.ssh = client
      const sftp = await new Promise<any>((res, rej) => client.sftp((e, s) => (e ? rej(e) : res(s))))
      session.fs = new SftpFS(sftp, (cmd) => execOn(client, cmd))
      client.on('close', () => onLost(serverId, client))
      client.on('error', () => {})
      const home = await session.fs.home().catch(() => '/')
      setState(session, { status: 'connected', home, fingerprint, error: undefined })
    } else {
      if (!password && server.username && server.username !== 'anonymous') throw new AuthRequiredError()
      const fs = new FtpFS(() => connectFTP(server, password))
      await fs.init()
      session.fs = fs
      setState(session, { status: 'connected', home: await fs.home(), error: undefined })
    }
    if (opts.remember && opts.password) {
      if (server.authMethod === 'key') store.saveServer({ ...store.listServers().find((s) => s.id === serverId)!, passphrase: opts.password })
      else store.saveServer({ ...store.listServers().find((s) => s.id === serverId)!, password: opts.password })
    }
    store.touchServer(serverId)
    return session.state
  } catch (err: any) {
    session.ssh?.end()
    sessions.delete(serverId)
    const msg = err instanceof AuthRequiredError ? 'NEED_PASSWORD' : friendlyError(err)
    emit('conn:state', { serverId, status: msg === 'NEED_PASSWORD' ? 'disconnected' : 'error', error: msg, canExec: false })
    throw new Error(msg)
  }
}

function friendlyError(err: any): string {
  const m: string = err?.message ?? String(err)
  if (err?.code === 'ECONNREFUSED') return 'Connection refused — is the server running and the port correct?'
  if (err?.code === 'ENOTFOUND') return 'Host not found — check the address.'
  if (err?.code === 'ETIMEDOUT' || /Timed out/i.test(m)) return 'Connection timed out.'
  if (err?.code === 'EHOSTUNREACH') return 'Host unreachable.'
  if (/530/.test(m)) return 'Login incorrect (FTP 530).'
  return m
}

function onLost(serverId: string, client: Client) {
  const s = sessions.get(serverId)
  if (!s || s.ssh !== client) return
  for (const [id, t] of terminals) if (t.serverId === serverId) { emit('term:exit', { id, code: null }); terminals.delete(id) }
  for (const [id, t] of streams) if (t.serverId === serverId) { emit('stream:event', { id, type: 'exit', code: null }); streams.delete(id) }
  sessions.delete(serverId)
  emit('conn:state', { serverId, status: 'error', error: 'Connection lost', canExec: true })
}

export async function disconnect(serverId: string) {
  const s = sessions.get(serverId)
  if (!s) return
  sessions.delete(serverId)
  for (const [id, t] of terminals) if (t.serverId === serverId) { t.channel.close(); terminals.delete(id) }
  for (const [id, t] of streams) if (t.serverId === serverId) { t.channel.close(); streams.delete(id) }
  s.fs?.close()
  s.ssh?.end()
  emit('conn:state', { serverId, status: 'disconnected', canExec: false })
}

export function disconnectAll() {
  for (const id of [...sessions.keys()]) disconnect(id)
}

function session(serverId: string): Session {
  const s = sessions.get(serverId)
  if (!s || s.state.status !== 'connected') throw new Error('Not connected to this server')
  return s
}

export function getFS(serverId: string): RemoteFS {
  return session(serverId).fs!
}

export function hasExec(serverId: string) {
  return !!sessions.get(serverId)?.ssh
}

function sshClient(serverId: string): Client {
  const c = session(serverId).ssh
  if (!c) throw new Error('This server is connected via FTP — shell commands need an SSH connection')
  return c
}

function openExec(client: Client, cmd: string, pty = false): Promise<ClientChannel> {
  return new Promise((resolve, reject) => {
    const attempt = (n: number) =>
      client.exec(cmd, pty ? { pty: { term: 'xterm-256color', cols: 200, rows: 50 } } : {}, (err, ch) => {
        if (err && n > 0 && /open failure|Channel open/i.test(err.message)) return setTimeout(() => attempt(n - 1), 300)
        if (err) return reject(err)
        resolve(ch)
      })
    attempt(3)
  })
}

function execOn(client: Client, cmd: string, timeoutMs = 60000): Promise<ExecResult> {
  return openExec(client, cmd).then(
    (ch) =>
      new Promise((resolve) => {
        const out: Buffer[] = []
        const errOut: Buffer[] = []
        let code: number | null = null
        const t = setTimeout(() => ch.close(), timeoutMs)
        ch.on('data', (d: Buffer) => out.push(d))
        ch.stderr.on('data', (d: Buffer) => errOut.push(d))
        ch.on('exit', (c: number | null) => (code = c))
        ch.on('close', () => {
          clearTimeout(t)
          resolve({ stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(errOut).toString('utf8'), code })
        })
      }),
  )
}

export function exec(serverId: string, cmd: string, timeoutMs?: number) {
  return execOn(sshClient(serverId), cmd, timeoutMs)
}

export async function startStream(serverId: string, id: string, cmd: string) {
  const ch = await openExec(sshClient(serverId), cmd, true)
  streams.set(id, { serverId, channel: ch })
  const dec = new StringDecoder('utf8')
  ch.on('data', (d: Buffer) => emit('stream:event', { id, type: 'data', data: dec.write(d) }))
  ch.stderr.on('data', (d: Buffer) => emit('stream:event', { id, type: 'data', data: d.toString('utf8') }))
  let code: number | null = null
  ch.on('exit', (c: number | null) => (code = c))
  ch.on('close', () => {
    streams.delete(id)
    emit('stream:event', { id, type: 'exit', code })
  })
}

export function stopStream(id: string) {
  const s = streams.get(id)
  if (!s) return
  try {
    s.channel.write('\x03')
    s.channel.signal('INT')
  } catch { /* ignore */ }
  setTimeout(() => s.channel.close(), 150)
}

export async function openTerminal(serverId: string, id: string, cols: number, rows: number, cwd?: string) {
  const client = sshClient(serverId)
  const ch = await new Promise<ClientChannel>((resolve, reject) =>
    client.shell({ term: 'xterm-256color', cols, rows }, { env: { LANG: 'en_US.UTF-8', TERM_PROGRAM: 'SSH-OS' } } as any, (e, c) =>
      e ? reject(e) : resolve(c),
    ),
  )
  terminals.set(id, { serverId, channel: ch })
  const dec = new StringDecoder('utf8')
  ch.on('data', (d: Buffer) => emit('term:data', { id, data: dec.write(d) }))
  ch.stderr.on('data', (d: Buffer) => emit('term:data', { id, data: d.toString('utf8') }))
  ch.on('close', () => {
    if (terminals.delete(id)) emit('term:exit', { id, code: null })
  })
  if (cwd) ch.write(`cd -- '${cwd.replace(/'/g, `'\\''`)}' && clear\n`)
}

export function writeTerminal(id: string, data: string) {
  terminals.get(id)?.channel.write(data)
}

export function resizeTerminal(id: string, cols: number, rows: number) {
  terminals.get(id)?.channel.setWindow(rows, cols, 0, 0)
}

export function closeTerminal(id: string) {
  const t = terminals.get(id)
  if (!t) return
  terminals.delete(id)
  t.channel.close()
}
