/**
 * Talks to `codex app-server` on an SSH server over JSON-RPC (one JSON message per line on
 * stdin/stdout), the same protocol the official Codex IDE extensions use.
 */
import { api, shq } from '../api'

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; method: string }
export type Notification = { method: string; params: any }
export type ServerRequest = { id: number | string; method: string; params: any }

export class CodexClient {
  readonly pid = 'codex-' + Math.random().toString(36).slice(2, 10)
  private nextId = 1
  private pending = new Map<number | string, Pending>()
  private buf = ''
  private off: (() => void) | null = null
  private listeners = new Set<(n: Notification) => void>()
  private stderrTail: string[] = []
  closed = false
  onExit: ((reason: string) => void) | null = null
  /** answers approval and input requests from the server; return the JSON-RPC result */
  onServerRequest: ((r: ServerRequest) => Promise<any>) | null = null

  constructor(readonly hostId: string, readonly codexPath: string) {}

  async start() {
    this.off = api.on('proc:event', (e: { id: string; type: string; data?: string; code?: number | null }) => {
      if (e.id !== this.pid) return
      if (e.type === 'stdout') this.feed(e.data ?? '')
      else if (e.type === 'stderr') {
        // keep the last lines for error messages (strip ANSI colours)
        // eslint-disable-next-line no-control-regex
        const lines = (e.data ?? '').replace(/\x1b\[[0-9;]*m/g, '').split('\n').filter((l) => l.trim())
        this.stderrTail = [...this.stderrTail, ...lines].slice(-12)
      } else if (e.type === 'exit') this.finish(`Codex stopped${e.code != null ? ` (exit ${e.code})` : ''}`)
    })
    // a login shell gives Codex the user's normal PATH and environment
    const cmd = `exec bash -lc ${shq(`cd ~ && exec ${this.codexPath} app-server`)}`
    await api.proc.start(this.hostId, this.pid, cmd).catch((err) => {
      this.finish(err.message)
      throw err
    })
    const init = await this.request('initialize', { clientInfo: { name: 'sshos', title: 'SSH OS', version: '2.3' }, capabilities: null }, 30000)
    this.notify('initialized')
    return init
  }

  private feed(chunk: string) {
    this.buf += chunk
    let i: number
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim()
      this.buf = this.buf.slice(i + 1)
      if (!line.startsWith('{')) continue
      let m: any
      try { m = JSON.parse(line) } catch { continue }
      this.dispatch(m)
    }
  }

  private dispatch(m: any) {
    if (m.method && m.id !== undefined) {
      // request from the server (approvals, questions)
      const h = this.onServerRequest
      Promise.resolve(h ? h({ id: m.id, method: m.method, params: m.params }) : null)
        .then((result) => this.send({ id: m.id, result: result ?? {} }))
        .catch((e) => this.send({ id: m.id, error: { code: -32000, message: String(e?.message ?? e) } }))
      return
    }
    if (m.method) {
      for (const l of this.listeners) l({ method: m.method, params: m.params })
      return
    }
    const p = this.pending.get(m.id)
    if (!p) return
    this.pending.delete(m.id)
    if (m.error) p.reject(new Error(m.error.message || `${p.method} failed`))
    else p.resolve(m.result)
  }

  private send(o: any) {
    if (this.closed) return Promise.reject(new Error('Codex is not running'))
    return api.proc.write(this.pid, JSON.stringify(o) + '\n')
  }

  request<T = any>(method: string, params: any = {}, timeout = 120000): Promise<T> {
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const t = timeout ? setTimeout(() => { if (this.pending.delete(id)) reject(new Error(`${method} timed out`)) }, timeout) : null
      this.pending.set(id, { method, resolve: (v) => { if (t) clearTimeout(t); resolve(v) }, reject: (e) => { if (t) clearTimeout(t); reject(e) } })
      this.send({ id, method, params }).catch((e) => { this.pending.delete(id); if (t) clearTimeout(t); reject(e) })
    })
  }

  notify(method: string, params?: any) {
    return this.send(params === undefined ? { method } : { method, params }).catch(() => {})
  }

  on(fn: (n: Notification) => void) {
    this.listeners.add(fn)
    return () => { this.listeners.delete(fn) }
  }

  get lastErrors() { return this.stderrTail.join('\n') }

  private finish(reason: string) {
    if (this.closed) return
    this.closed = true
    this.off?.()
    for (const p of this.pending.values()) p.reject(new Error(reason))
    this.pending.clear()
    this.onExit?.(reason)
  }

  async stop() {
    if (this.closed) return
    await api.proc.stop(this.pid).catch(() => {})
    this.finish('Closed')
  }
}
