import { app, shell } from 'electron'
import { promises as fs } from 'fs'
import { basename, join, posix, resolve, sep } from 'path'
import { randomUUID } from 'crypto'
import { tmpdir } from 'os'
import { Transfer } from '../shared/types'
import { exec, getFS, hasExec } from './connections'
import { RemoteFS, shq } from './remote-fs'

type Emit = (channel: string, payload: unknown) => void
let emit: Emit = () => {}
export function setTransferEmitter(fn: Emit) {
  emit = fn
}

const active = new Map<string, Transfer & { cancelled?: boolean }>()

function begin(serverId: string, kind: Transfer['kind'], name: string, total: number) {
  const t: Transfer = { id: randomUUID(), serverId, kind, name, total, done: 0, status: 'running', startedAt: Date.now() }
  active.set(t.id, t)
  emit('transfer', t)
  return t
}

let lastEmit = 0
function progress(t: Transfer, done: number) {
  t.done = done
  const now = Date.now()
  if (now - lastEmit > 100) {
    lastEmit = now
    emit('transfer', t)
  }
}

function finish(t: Transfer, err?: unknown) {
  const tt = active.get(t.id)
  t.status = tt?.cancelled ? 'cancelled' : err ? 'error' : 'done'
  if (err) t.error = (err as Error).message
  if (!err) t.done = t.total
  emit('transfer', t)
  active.delete(t.id)
}

export function cancelTransfer(id: string) {
  const t = active.get(id)
  if (t) t.cancelled = true
}

function checkCancel(t: Transfer) {
  if (active.get(t.id)?.cancelled) throw new Error('Cancelled')
}

// ---------- local helpers ----------
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i

/** A remote file name as one safe path component for the local disk, or null if unsafe. */
export function safeLocalName(name: string): string | null {
  const n = name.replace(/[. ]+$/, '')
  // eslint-disable-next-line no-control-regex
  if (!n || n.length > 255 || /[\/\\:<>"|?*\x00-\x1f]/.test(n) || n === '.' || n === '..' || RESERVED.test(n)) return null
  return n
}

/** join(dir, name) that is guaranteed to stay inside dir. */
function localChild(dir: string, name: string): string | null {
  const n = safeLocalName(name)
  if (!n) return null
  const p = resolve(dir, n)
  return p.startsWith(resolve(dir) + sep) ? p : null
}

async function localSize(path: string): Promise<number> {
  const st = await fs.stat(path)
  if (!st.isDirectory()) return st.size
  let total = 0
  for (const n of await fs.readdir(path)) total += await localSize(join(path, n))
  return total
}

async function remoteSize(rfs: RemoteFS, path: string, isDir: boolean): Promise<number> {
  if (!isDir) return (await rfs.stat(path)).size
  let total = 0
  for (const e of await rfs.list(path)) total += e.type === 'dir' ? await remoteSize(rfs, e.path, true) : e.size
  return total
}

async function uniqueLocal(dir: string, name: string) {
  let candidate = join(dir, name)
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  for (let i = 2; ; i++) {
    try {
      await fs.access(candidate)
      candidate = join(dir, `${stem} ${i}${ext}`)
    } catch {
      return candidate
    }
  }
}

// ---------- upload ----------
async function uploadRec(rfs: RemoteFS, t: Transfer, local: string, remote: string, base: { n: number }) {
  checkCancel(t)
  const st = await fs.stat(local)
  if (st.isDirectory()) {
    await rfs.mkdir(remote).catch(() => {})
    for (const n of await fs.readdir(local)) {
      if (n === '.DS_Store') continue
      await uploadRec(rfs, t, join(local, n), posix.join(remote, n), base)
    }
  } else {
    const start = base.n
    await rfs.upload(local, remote, (b) => progress(t, start + b))
    base.n += st.size
    progress(t, base.n)
  }
}

export async function upload(serverId: string, localPaths: string[], remoteDir: string) {
  const rfs = getFS(serverId)
  const total = (await Promise.all(localPaths.map(localSize))).reduce((a, b) => a + b, 0)
  const name = localPaths.length === 1 ? basename(localPaths[0]) : `${localPaths.length} items`
  const t = begin(serverId, 'upload', name, total)
  try {
    const base = { n: 0 }
    for (const lp of localPaths) await uploadRec(rfs, t, lp, posix.join(remoteDir, basename(lp)), base)
    finish(t)
  } catch (e) {
    finish(t, e)
    throw e
  }
}

// ---------- download ----------
async function downloadRec(rfs: RemoteFS, t: Transfer, remote: string, isDir: boolean, local: string, base: { n: number }) {
  checkCancel(t)
  if (isDir) {
    await fs.mkdir(local, { recursive: true })
    for (const e of await rfs.list(remote)) {
      const child = localChild(local, e.name)
      if (!child) continue // skip names that would escape the folder or are invalid locally
      await downloadRec(rfs, t, e.path, e.type === 'dir', child, base)
    }
  } else {
    const start = base.n
    let last = 0
    await rfs.download(remote, local, (b) => { last = b; progress(t, start + b) })
    base.n = start + Math.max(last, (await fs.stat(local)).size)
    progress(t, base.n)
  }
}

export async function download(serverId: string, items: { path: string; isDir: boolean }[], localDir?: string, reveal = true) {
  const rfs = getFS(serverId)
  const dir = localDir || app.getPath('downloads')
  const total = (await Promise.all(items.map((i) => remoteSize(rfs, i.path, i.isDir).catch(() => 0)))).reduce((a, b) => a + b, 0)
  const name = items.length === 1 ? posix.basename(items[0].path) : `${items.length} items`
  const t = begin(serverId, 'download', name, total)
  const outPaths: string[] = []
  try {
    const base = { n: 0 }
    for (const it of items) {
      const target = await uniqueLocal(dir, safeLocalName(posix.basename(it.path)) ?? 'download')
      outPaths.push(target)
      await downloadRec(rfs, t, it.path, it.isDir, target, base)
    }
    finish(t)
    if (reveal && outPaths[0]) shell.showItemInFolder(outPaths[0])
    return outPaths
  } catch (e) {
    finish(t, e)
    throw e
  }
}

/** Download to a temp location and open with the default macOS app. */
export async function openLocally(serverId: string, path: string) {
  const dir = join(tmpdir(), 'ssh-os', randomUUID())
  await fs.mkdir(dir, { recursive: true })
  const [p] = await download(serverId, [{ path, isDir: false }], dir, false)
  const err = await shell.openPath(p)
  if (err) throw new Error(err)
}

// ---------- copy (same or across servers) ----------
async function remoteUnique(rfs: RemoteFS, dir: string, name: string) {
  const existing = new Set((await rfs.list(dir)).map((e) => e.name))
  if (!existing.has(name)) return posix.join(dir, name)
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  for (let i = 1; ; i++) {
    const n = i === 1 ? `${stem} copy${ext}` : `${stem} copy ${i}${ext}`
    if (!existing.has(n)) return posix.join(dir, n)
  }
}

export async function copy(
  src: { serverId: string; items: { path: string; isDir: boolean }[] },
  dst: { serverId: string; dir: string },
  move = false,
) {
  const srcFS = getFS(src.serverId)
  const dstFS = getFS(dst.serverId)

  // Same server: use rename for moves, cp for SSH copies
  if (src.serverId === dst.serverId) {
    for (const it of src.items) {
      const target = move ? posix.join(dst.dir, posix.basename(it.path)) : await remoteUnique(dstFS, dst.dir, posix.basename(it.path))
      if (target === it.path) continue
      if (move) await srcFS.rename(it.path, target)
      else if (hasExec(src.serverId)) {
        const r = await exec(src.serverId, `cp -a -- ${shq(it.path)} ${shq(target)}`, 600000)
        if (r.code !== 0) throw new Error(r.stderr.trim() || 'Copy failed')
      } else {
        await crossCopy(srcFS, dstFS, src.serverId, [it], dst.dir)
      }
    }
    return
  }
  await crossCopy(srcFS, dstFS, dst.serverId, src.items, dst.dir)
  if (move) for (const it of src.items) await srcFS.remove(it.path, it.isDir)
}

async function crossCopy(srcFS: RemoteFS, dstFS: RemoteFS, dstServerId: string, items: { path: string; isDir: boolean }[], dstDir: string) {
  const tmp = join(tmpdir(), 'ssh-os', randomUUID())
  await fs.mkdir(tmp, { recursive: true })
  const total = (await Promise.all(items.map((i) => remoteSize(srcFS, i.path, i.isDir).catch(() => 0)))).reduce((a, b) => a + b, 0)
  const name = items.length === 1 ? posix.basename(items[0].path) : `${items.length} items`
  const t = begin(dstServerId, 'copy', name, total * 2)
  try {
    const base = { n: 0 }
    const locals: string[] = []
    for (const it of items) {
      const lp = localChild(tmp, posix.basename(it.path))
      if (!lp) throw new Error(`Unsafe file name: ${posix.basename(it.path)}`)
      locals.push(lp)
      await downloadRec(srcFS, t, it.path, it.isDir, lp, base)
    }
    for (const lp of locals) {
      const target = await remoteUnique(dstFS, dstDir, basename(lp))
      await uploadRec(dstFS, t, lp, target, base)
    }
    finish(t)
  } catch (e) {
    finish(t, e)
    throw e
  } finally {
    fs.rm(tmp, { recursive: true, force: true }).catch(() => {})
  }
}
