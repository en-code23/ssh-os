import { contextBridge, ipcRenderer, webUtils } from 'electron'

async function call(channel: string, ...args: unknown[]) {
  const r = await ipcRenderer.invoke(channel, ...args)
  if (!r.ok) throw new Error(r.error)
  return r.value
}

function on(channel: string, cb: (payload: any) => void) {
  const fn = (_e: unknown, payload: unknown) => cb(payload)
  ipcRenderer.on(channel, fn)
  return () => {
    ipcRenderer.removeListener(channel, fn)
  }
}

const api = {
  call,
  on,
  termWrite: (id: string, data: string) => ipcRenderer.send('term:write', id, data),
  termResize: (id: string, cols: number, rows: number) => ipcRenderer.send('term:resize', id, cols, rows),
  pathForFile: (f: File) => webUtils.getPathForFile(f),
  platform: process.platform,
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
