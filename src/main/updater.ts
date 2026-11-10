/**
 * Automatic updates.
 *  - Windows: electron-updater (NSIS, differential downloads, silent install).
 *  - macOS:   the app is only ad-hoc signed, so Squirrel.Mac cannot verify updates.
 *             Instead we download the release .zip from GitHub, verify its SHA-256
 *             (published by GitHub for every release asset), swap the .app bundle
 *             with a small helper script after we quit, and relaunch.
 */
import { app, net } from 'electron'
import { spawn } from 'child_process'
import { createHash } from 'crypto'
import { createWriteStream, promises as fs, accessSync, constants } from 'fs'
import { tmpdir } from 'os'
import { dirname, join, resolve } from 'path'
import { autoUpdater } from 'electron-updater'
import { store } from './store'

const REPO = 'en-code23/ssh-os'

export type UpdateStatus = 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error' | 'unsupported'

export interface UpdateState {
  status: UpdateStatus
  current: string
  version?: string
  notes?: string
  progress?: number
  error?: string
  checkedAt?: number
}

let emit: (s: UpdateState) => void = () => {}
let state: UpdateState = { status: 'idle', current: app.getVersion() }
let macUpdate: { url: string; sha256?: string; zipPath?: string; appPath?: string } | null = null
let timer: NodeJS.Timeout | null = null

function set(p: Partial<UpdateState>) {
  state = { ...state, ...p }
  emit(state)
}

export function getUpdateState() {
  return state
}

function newer(a: string, b: string) {
  const pa = a.replace(/^v/, '').split(/[.-]/).map((x) => parseInt(x) || 0)
  const pb = b.replace(/^v/, '').split(/[.-]/).map((x) => parseInt(x) || 0)
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0)
  return false
}

const supported = () => app.isPackaged && (process.platform === 'darwin' || process.platform === 'win32')

// ------------------------------------------------------------------ Windows
function initWindows() {
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.logger = null
  autoUpdater.on('checking-for-update', () => set({ status: 'checking', error: undefined }))
  autoUpdater.on('update-available', (i) =>
    set({ status: 'available', version: i.version, notes: typeof i.releaseNotes === 'string' ? i.releaseNotes : undefined, checkedAt: Date.now() }),
  )
  autoUpdater.on('update-not-available', () => set({ status: 'not-available', checkedAt: Date.now() }))
  autoUpdater.on('download-progress', (p) => set({ status: 'downloading', progress: p.percent / 100 }))
  autoUpdater.on('update-downloaded', (i) => set({ status: 'downloaded', version: i.version, progress: 1 }))
  autoUpdater.on('error', (e) => set({ status: 'error', error: e?.message ?? String(e) }))
}

// ------------------------------------------------------------------ macOS
function bundlePath() {
  // .../SSH OS.app/Contents/MacOS/SSH OS -> .../SSH OS.app
  return resolve(app.getPath('exe'), '../../..')
}

async function macCheck() {
  set({ status: 'checking', error: undefined })
  const res = await net.fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': `ssh-os/${app.getVersion()}` },
  })
  if (!res.ok) throw new Error(`GitHub responded ${res.status}`)
  const rel = await res.json()
  const version = String(rel.tag_name ?? '').replace(/^v/, '')
  if (!version || !newer(version, app.getVersion())) {
    macUpdate = null
    return set({ status: 'not-available', checkedAt: Date.now() })
  }
  const name = `SSH-OS-mac-${process.arch}.zip`
  const asset = (rel.assets ?? []).find((a: any) => a.name === name)
  if (!asset) throw new Error(`Release ${version} has no ${name}`)
  const url: string = asset.browser_download_url
  if (!/^https:\/\/github\.com\//.test(url)) throw new Error('Unexpected download URL')
  const sha256 = typeof asset.digest === 'string' && /^sha256:[a-f0-9]{64}$/.test(asset.digest) ? asset.digest.slice(7) : undefined
  // never install an update we cannot verify
  if (!sha256) throw new Error('The update has no checksum to verify it, so it was not installed.')
  macUpdate = { url, sha256 }
  set({ status: 'available', version, notes: rel.body ?? undefined, checkedAt: Date.now() })
}

async function macDownload() {
  if (!macUpdate) throw new Error('No update available')
  const dir = join(tmpdir(), `ssh-os-update-${Date.now()}`)
  await fs.mkdir(dir, { recursive: true })
  const zip = join(dir, 'update.zip')
  const res = await net.fetch(macUpdate.url, { headers: { 'User-Agent': `ssh-os/${app.getVersion()}` } })
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status})`)
  const total = Number(res.headers.get('content-length')) || 0
  const hash = createHash('sha256')
  const out = createWriteStream(zip)
  let done = 0
  let last = 0
  const reader = res.body.getReader()
  set({ status: 'downloading', progress: 0 })
  for (;;) {
    const { done: end, value } = await reader.read()
    if (end) break
    hash.update(value)
    done += value.length
    if (!out.write(value)) await new Promise((r) => out.once('drain', r))
    if (total && Date.now() - last > 150) {
      last = Date.now()
      set({ progress: done / total })
    }
  }
  await new Promise<void>((r, j) => out.end((e?: Error | null) => (e ? j(e) : r())))
  const digest = hash.digest('hex')
  if (!macUpdate.sha256 || digest !== macUpdate.sha256) throw new Error('Downloaded update failed its checksum. Try again.')
  // unpack with ditto (preserves the bundle's symlinks and signature)
  await new Promise<void>((r, j) => {
    const p = spawn('/usr/bin/ditto', ['-x', '-k', zip, join(dir, 'app')])
    p.on('exit', (c) => (c === 0 ? r() : j(new Error('Could not unpack the update'))))
  })
  const appPath = join(dir, 'app', 'SSH OS.app')
  await fs.access(appPath)
  macUpdate = { ...macUpdate, zipPath: zip, appPath }
  set({ status: 'downloaded', progress: 1 })
}

function macInstall() {
  if (!macUpdate?.appPath) throw new Error('Update not downloaded yet')
  const target = bundlePath()
  if (!target.endsWith('.app')) throw new Error('Unexpected app location')
  if (target.startsWith('/Volumes/')) throw new Error('Move SSH OS to your Applications folder first, then update.')
  try {
    accessSync(dirname(target), constants.W_OK)
  } catch {
    throw new Error(`No permission to replace the app in ${dirname(target)}. Move it to /Applications or your home folder.`)
  }
  const script = `
pid=${process.pid}
while kill -0 "$pid" 2>/dev/null; do sleep 0.3; done
T="$1"; N="$2"
rm -rf "$T.old"
if mv "$T" "$T.old" && /usr/bin/ditto "$N" "$T"; then rm -rf "$T.old"; else rm -rf "$T"; mv "$T.old" "$T"; fi
/usr/bin/xattr -cr "$T" 2>/dev/null
rm -rf "$(dirname "$(dirname "$N")")"
/usr/bin/open "$T"
`
  const child = spawn('/bin/sh', ['-c', script, 'sh', target, macUpdate.appPath], { detached: true, stdio: 'ignore' })
  child.unref()
  app.quit()
}

// ------------------------------------------------------------------ API
export function initUpdater(onState: (s: UpdateState) => void) {
  emit = onState
  if (!supported()) {
    state = { status: 'unsupported', current: app.getVersion() }
    return
  }
  if (process.platform === 'win32') initWindows()
  const auto = () => {
    const s = store.getSettings()
    if (!s.autoCheckUpdates) return
    checkForUpdates()
      .then(() => {
        if (state.status === 'available' && store.getSettings().autoDownloadUpdates) return downloadUpdate()
      })
      .catch(() => {})
  }
  setTimeout(auto, 8000)
  timer = setInterval(auto, 6 * 60 * 60 * 1000)
}

export async function checkForUpdates() {
  if (!supported()) return set({ status: 'unsupported' })
  if (state.status === 'downloading') return
  try {
    if (process.platform === 'win32') await autoUpdater.checkForUpdates()
    else await macCheck()
  } catch (e: any) {
    set({ status: 'error', error: e?.message ?? String(e) })
  }
}

export async function downloadUpdate() {
  if (state.status === 'downloaded' || state.status === 'downloading') return
  try {
    if (process.platform === 'win32') await autoUpdater.downloadUpdate()
    else await macDownload()
  } catch (e: any) {
    set({ status: 'error', error: e?.message ?? String(e) })
  }
}

export function installUpdate() {
  if (process.platform === 'win32') autoUpdater.quitAndInstall(true, true)
  else macInstall()
}

export function stopUpdater() {
  if (timer) clearInterval(timer)
}
