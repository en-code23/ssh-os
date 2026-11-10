import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, shell, clipboard, net } from 'electron'
import { join, posix } from 'path'
import { readFileSync } from 'fs'
import { homedir } from 'os'
import { randomUUID } from 'crypto'
import { ServerConfig, Settings, QuickCommand } from '../shared/types'
import { store } from './store'
import * as conn from './connections'
import * as xfer from './transfers'
import * as updater from './updater'

let win: BrowserWindow | null = null
const isMac = process.platform === 'darwin'
/** mac accelerator, Windows/Linux accelerator (avoid shell keys like Ctrl+W/K/R in the terminal) */
const acc = (mac: string, other?: string) => (isMac ? mac : other)

function broadcast(channel: string, payload: unknown) {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(channel, payload)
}
conn.setEmitter(broadcast)
xfer.setTransferEmitter(broadcast)

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    show: false,
    ...(isMac
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 12, y: 6 }, vibrancy: 'under-window' as const, visualEffectState: 'active' as const }
      : { titleBarStyle: 'hidden' as const, titleBarOverlay: overlayColors(), autoHideMenuBar: true }),
    backgroundColor: '#1e1e1e',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      plugins: true,
    },
  })
  win.once('ready-to-show', () => win?.show())
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e) => e.preventDefault())
  if (process.env['ELECTRON_RENDERER_URL']) win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  else win.loadFile(join(__dirname, '../renderer/index.html'))
  win.on('enter-full-screen', () => broadcast('app:fullscreen', true))
  win.on('leave-full-screen', () => broadcast('app:fullscreen', false))
}

function overlayColors() {
  return { color: '#00000000', symbolColor: nativeTheme.shouldUseDarkColors ? '#ffffff' : '#1d1d1f', height: 28 }
}

function menuAction(action: string) {
  return () => broadcast('menu', action)
}

function buildMenu() {
  const tpl: Electron.MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { label: `About ${app.name}`, click: menuAction('about') },
        { label: 'Check for Updates…', click: () => { broadcast('menu', 'updates'); updater.checkForUpdates() } },
        { type: 'separator' },
        { label: 'Settings…', accelerator: acc('Cmd+,', 'Ctrl+,'), click: menuAction('settings') },
        { type: 'separator' },
        ...(isMac
          ? ([{ role: 'services' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }] as Electron.MenuItemConstructorOptions[])
          : []),
        { role: 'quit' },
      ],
    },
    {
      label: 'File',
      submenu: [
        { label: 'New Finder Window', accelerator: acc('Cmd+N', 'Ctrl+Alt+N'), click: menuAction('new-finder') },
        { label: 'New Terminal', accelerator: acc('Cmd+Shift+T', 'Ctrl+Alt+T'), click: menuAction('new-terminal') },
        { label: 'New Tab', accelerator: acc('Cmd+T', 'Ctrl+Shift+T'), click: menuAction('new-tab') },
        { type: 'separator' },
        { label: 'Connect to Server…', accelerator: acc('Cmd+K', 'Ctrl+Alt+K'), click: menuAction('servers') },
        { type: 'separator' },
        { label: 'Close Window', accelerator: acc('Cmd+W', 'Ctrl+Shift+W'), click: menuAction('close-window') },
      ],
    },
    ...(isMac ? [{ role: 'editMenu' as const }] : []),
    {
      label: 'View',
      submenu: [
        { label: 'Spotlight', accelerator: acc('Cmd+Shift+Space', 'Ctrl+Shift+Space'), click: menuAction('spotlight') },
        { label: 'Show Hidden Files', accelerator: acc('Cmd+Shift+.', 'Ctrl+Shift+.'), click: menuAction('toggle-hidden') },
        { type: 'separator' },
        ...(isMac ? [{ role: 'reload' as const }] : [{ role: 'reload' as const, accelerator: 'F5' }]),
        { role: 'toggleDevTools', accelerator: acc('Alt+Cmd+I', 'F12') },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Go',
      submenu: [
        { label: 'Home', accelerator: acc('Cmd+Shift+H', 'Ctrl+Shift+H'), click: menuAction('go-home') },
        { label: 'Computer (/)', accelerator: acc('Cmd+Shift+C', 'Ctrl+Alt+C'), click: menuAction('go-root') },
        { label: 'Go to Folder…', accelerator: acc('Cmd+Shift+G', 'Ctrl+Shift+G'), click: menuAction('go-folder') },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { label: 'Minimize', accelerator: acc('Cmd+M'), click: menuAction('minimize-window') },
        { label: 'Zoom', click: menuAction('zoom-window') },
        { type: 'separator' },
        { label: 'Cycle Windows', accelerator: acc('Cmd+`', 'Ctrl+`'), click: menuAction('cycle-windows') },
        { type: 'separator' },
        { role: 'front' },
      ],
    },
    {
      role: 'help',
      submenu: [{ label: 'Keyboard Shortcuts', click: menuAction('help') }],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(tpl))
}

/** Wrap handlers so errors arrive with clean messages. */
function handle(channel: string, fn: (...args: any[]) => any) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      return { ok: true, value: await fn(...args) }
    } catch (err: any) {
      return { ok: false, error: err?.message ?? String(err) }
    }
  })
}

function parseSshConfig(): Partial<ServerConfig>[] {
  let text = ''
  try {
    text = readFileSync(join(homedir(), '.ssh', 'config'), 'utf8')
  } catch {
    return []
  }
  const hosts: Partial<ServerConfig>[] = []
  let cur: Partial<ServerConfig> | null = null
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const m = line.match(/^(\S+)\s*=?\s*(.+)$/)
    if (!m) continue
    const key = m[1].toLowerCase()
    const val = m[2].trim().replace(/^"|"$/g, '')
    if (key === 'host') {
      cur = null
      if (/[*?!]/.test(val)) continue
      cur = { name: val.split(/\s+/)[0], host: val.split(/\s+/)[0], port: 22, protocol: 'ssh', authMethod: 'agent' }
      hosts.push(cur)
    } else if (cur) {
      if (key === 'hostname') cur.host = val
      else if (key === 'port') cur.port = parseInt(val) || 22
      else if (key === 'user') cur.username = val
      else if (key === 'identityfile') {
        cur.privateKeyPath = val
        cur.authMethod = 'key'
      }
    }
  }
  return hosts
}

function registerIpc() {
  // servers
  handle('servers:list', () => store.listServers())
  handle('servers:save', (s: ServerConfig & { clearPassword?: boolean }) => store.saveServer({ ...s, id: s.id || randomUUID() }))
  handle('servers:delete', async (id: string) => {
    await conn.disconnect(id)
    store.deleteServer(id)
  })
  handle('servers:importSshConfig', () => parseSshConfig())
  handle('servers:forgetHostKey', (host: string, port: number) => store.setKnownHost(`${host}:${port}`, undefined))
  handle('servers:test', async (s: ServerConfig) => {
    const prev = s.id ? store.getServerWithSecrets(s.id) : undefined
    const tmp = store.saveServer({
      ...s,
      password: s.password || prev?.password,
      passphrase: s.passphrase || prev?.passphrase,
      id: '__test__' + randomUUID(),
    })
    s = { ...s, password: s.password || prev?.password }
    try {
      await conn.connect(tmp.id, { password: s.password })
      return true
    } finally {
      await conn.disconnect(tmp.id)
      store.deleteServer(tmp.id)
    }
  })

  // connections
  handle('conn:connect', (id: string, opts?: { password?: string; remember?: boolean }) => conn.connect(id, opts))
  handle('conn:disconnect', (id: string) => conn.disconnect(id))
  handle('conn:states', () => conn.getStates())

  // filesystem
  handle('fs:list', (id: string, path: string) => conn.getFS(id).list(path))
  handle('fs:stat', (id: string, path: string) => conn.getFS(id).stat(path))
  handle('fs:readText', async (id: string, path: string) => (await conn.getFS(id).read(path, 10 * 1024 * 1024)).toString('utf8'))
  handle('fs:readDataUrl', async (id: string, path: string, mime: string) => {
    const buf = await conn.getFS(id).read(path, 25 * 1024 * 1024)
    return `data:${mime};base64,${buf.toString('base64')}`
  })
  handle('fs:writeText', (id: string, path: string, text: string) => conn.getFS(id).write(path, Buffer.from(text, 'utf8')))
  handle('fs:mkdir', (id: string, path: string) => conn.getFS(id).mkdir(path))
  handle('fs:rename', (id: string, from: string, to: string) => conn.getFS(id).rename(from, to))
  handle('fs:remove', async (id: string, items: { path: string; isDir: boolean }[]) => {
    for (const it of items) await conn.getFS(id).remove(it.path, it.isDir)
  })
  handle('fs:chmod', (id: string, path: string, mode: number) => {
    const f = conn.getFS(id)
    if (!f.chmod) throw new Error('Not supported')
    return f.chmod(path, mode)
  })
  handle('fs:diskFree', async (id: string, path: string) => {
    if (!conn.hasExec(id)) return null
    const r = await conn.exec(id, `df -Pk -- '${path.replace(/'/g, `'\\''`)}' | tail -1`)
    const parts = r.stdout.trim().split(/\s+/)
    return parts.length >= 4 ? parseInt(parts[3]) * 1024 : null
  })
  handle('fs:upload', (id: string, paths: string[], dir: string) => xfer.upload(id, paths, dir))
  handle('fs:uploadDialog', async (id: string, dir: string) => {
    const r = await dialog.showOpenDialog(win!, { properties: ['openFile', 'openDirectory', 'multiSelections'], buttonLabel: 'Upload' })
    if (r.canceled || !r.filePaths.length) return false
    await xfer.upload(id, r.filePaths, dir)
    return true
  })
  handle('fs:download', (id: string, items: { path: string; isDir: boolean }[]) => xfer.download(id, items))
  handle('fs:downloadTo', async (id: string, items: { path: string; isDir: boolean }[]) => {
    const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory', 'createDirectory'], buttonLabel: 'Download Here' })
    if (r.canceled || !r.filePaths[0]) return null
    return xfer.download(id, items, r.filePaths[0])
  })
  handle('fs:openLocally', (id: string, path: string) => xfer.openLocally(id, path))
  handle('fs:copy', (src: any, dst: any, move: boolean) => xfer.copy(src, dst, move))
  handle('transfer:cancel', (tid: string) => xfer.cancelTransfer(tid))

  // exec & streams
  handle('exec', (id: string, cmd: string, timeout?: number) => conn.exec(id, cmd, timeout))
  handle('stream:start', (id: string, sid: string, cmd: string) => conn.startStream(id, sid, cmd))
  handle('stream:stop', (sid: string) => conn.stopStream(sid))

  // terminal
  handle('term:open', (id: string, tid: string, cols: number, rows: number, cwd?: string) => conn.openTerminal(id, tid, cols, rows, cwd))
  ipcMain.on('term:write', (_e, tid: string, data: string) => conn.writeTerminal(tid, data))
  ipcMain.on('term:resize', (_e, tid: string, cols: number, rows: number) => conn.resizeTerminal(tid, cols, rows))
  handle('term:close', (tid: string) => conn.closeTerminal(tid))

  // misc
  handle('settings:get', () => store.getSettings())
  handle('settings:set', (patch: Partial<Settings>) => {
    const s = store.setSettings(patch)
    nativeTheme.themeSource = s.appearance === 'auto' ? 'system' : s.appearance
    broadcast('settings', s)
    return s
  })
  handle('commands:get', () => store.getQuickCommands())
  handle('commands:set', (c: QuickCommand[]) => store.setQuickCommands(c))
  handle('dialog:pickKey', async () => {
    const r = await dialog.showOpenDialog(win!, {
      defaultPath: join(homedir(), '.ssh'),
      properties: ['openFile', 'showHiddenFiles'],
      buttonLabel: 'Choose Key',
    })
    return r.canceled ? null : r.filePaths[0]
  })
  handle('clipboard:write', (text: string) => clipboard.writeText(text))
  handle('shell:openExternal', (url: string) => {
    if (/^https?:\/\//.test(url)) return shell.openExternal(url)
  })
  // Allow-listed JSON API access for the Minecraft manager (keeps the renderer CSP closed).
  const API_HOSTS = new Set([
    'api.modrinth.com', 'hangar.papermc.io', 'api.spiget.org', 'fill.papermc.io', 'api.purpurmc.org',
    'meta.fabricmc.net', 'piston-meta.mojang.com', 'launchermeta.mojang.com', 'api.mojang.com', 'api.github.com', 'api.adoptium.net',
  ])
  handle('http:json', async (url: string, opts?: { method?: string; body?: unknown }) => {
    const u = new URL(url)
    if (u.protocol !== 'https:' || !API_HOSTS.has(u.hostname)) throw new Error(`Host not allowed: ${u.hostname}`)
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 20000)
    try {
      const res = await net.fetch(url, {
        method: opts?.method ?? 'GET',
        headers: { 'User-Agent': `ssh-os/${app.getVersion()} (minecraft server manager)`, Accept: 'application/json', ...(opts?.body ? { 'Content-Type': 'application/json' } : {}) },
        body: opts?.body ? JSON.stringify(opts.body) : undefined,
        signal: ctrl.signal,
      })
      if (res.status === 404) return null
      if (!res.ok) throw new Error(`${u.hostname} responded ${res.status}`)
      return await res.json()
    } finally {
      clearTimeout(t)
    }
  })
  handle('update:state', () => updater.getUpdateState())
  handle('update:check', () => updater.checkForUpdates())
  handle('update:download', () => updater.downloadUpdate())
  handle('update:install', () => updater.installUpdate())
  handle('app:info', () => ({ version: app.getVersion(), electron: process.versions.electron, platform: process.platform }))
  handle('path:join', (...parts: string[]) => posix.join(...parts))
}

app.setName('SSH OS')
if (process.env.SSHOS_USER_DATA) app.setPath('userData', process.env.SSHOS_USER_DATA)
app.whenReady().then(() => {
  nativeTheme.themeSource = (() => {
    const a = store.getSettings().appearance
    return a === 'auto' ? 'system' : a
  })()
  registerIpc()
  buildMenu()
  nativeTheme.on('updated', () => { if (!isMac && win && !win.isDestroyed()) win.setTitleBarOverlay(overlayColors()) })
  createWindow()
  updater.initUpdater((s) => broadcast('update:state', s))
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => conn.disconnectAll())
app.on('window-all-closed', () => {
  conn.disconnectAll()
  app.quit()
})
