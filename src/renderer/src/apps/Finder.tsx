import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowUpFromLine, ChevronLeft, ChevronRight, Columns3, Download, Ellipsis, FolderPlus, Globe, HardDrive, Home,
  LayoutGrid, List, Monitor, ScrollText, Search, Settings2, Star, Terminal as TermIcon, Trash2, FolderOpen, Clock,
  Server as ServerIcon,
} from 'lucide-react'
import type { FileEntry } from '../../../shared/types'
import { api, isMac, Item, modKey, shq } from '../lib/api'
import {
  confirm, ensureConnected, prompt, toast, updateSettings, updateWindow, useStore, Win, disconnectServer,
} from '../lib/store'
import {
  baseName, category, ext, formatBytes, formatDate, isDirLike, joinPath, kindLabel, parentPath,
} from '../lib/files'
import { fsChanged, getInfo, openEntry, openInEditor, quickLook } from '../lib/actions'
import { Toolbar, useWinAction } from '../components/Window'
import { FileIcon, MenuItem, Spinner, useMenu } from '../components/ui'
import { launch } from './launch'

type View = 'icons' | 'list' | 'columns'
type SortKey = 'name' | 'modified' | 'size' | 'kind'
const DRAG_MIME = 'application/x-sshos-files'

function loadFavs(serverId: string): string[] {
  try {
    return JSON.parse(localStorage.getItem('favs:' + serverId) || '[]')
  } catch {
    return []
  }
}
function saveFavs(serverId: string, favs: string[]) {
  try {
    localStorage.setItem('favs:' + serverId, JSON.stringify(favs))
  } catch { /* ignore */ }
}

function sortEntries(list: FileEntry[], key: SortKey, asc: boolean) {
  const dir = asc ? 1 : -1
  return [...list].sort((a, b) => {
    // folders first like Finder's "Keep folders on top"
    const fa = isDirLike(a) ? 0 : 1
    const fb = isDirLike(b) ? 0 : 1
    if (fa !== fb) return fa - fb
    let r = 0
    if (key === 'name') r = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
    else if (key === 'modified') r = a.modified - b.modified
    else if (key === 'size') r = a.size - b.size
    else r = kindLabel(a).localeCompare(kindLabel(b))
    return r * dir || a.name.localeCompare(b.name)
  })
}

export function Finder({ win }: { win: Win }) {
  const serverId = win.serverId!
  const server = useStore((s) => s.servers.find((x) => x.id === serverId))
  const servers = useStore((s) => s.servers)
  const conns = useStore((s) => s.conns)
  const conn = conns[serverId]
  const showHidden = useStore((s) => s.settings.showHiddenFiles)
  const clipboard = useStore((s) => s.clipboard)
  const isSSH = server?.protocol === 'ssh'

  const [path, setPath] = useState<string>(win.props.path ?? '')
  const [history, setHistory] = useState<{ back: string[]; fwd: string[] }>({ back: [], fwd: [] })
  const [entries, setEntries] = useState<FileEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [anchor, setAnchor] = useState<string | null>(null)
  const [view, setView] = useState<View>(() => (localStorage.getItem('finder:view') as View) || 'list')
  const [sort, setSort] = useState<{ key: SortKey; asc: boolean }>({ key: 'name', asc: true })
  const [query, setQuery] = useState('')
  const [renaming, setRenaming] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [free, setFree] = useState<number | null>(null)
  const [favs, setFavs] = useState<string[]>(() => loadFavs(serverId))
  const [columns, setColumns] = useState<Record<string, FileEntry[]>>({})
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const menu = useMenu()
  const typeAhead = useRef({ s: '', t: 0 })

  const home = conn?.home ?? '/'

  // ---------- loading ----------
  const load = useCallback(
    async (p: string, keepSel = false) => {
      if (!conn || conn.status !== 'connected') return
      setLoading(true)
      setError(null)
      try {
        const list = await api.fs.list(serverId, p)
        setEntries(list)
        setColumns((c) => ({ ...c, [p]: list }))
        if (!keepSel) setSel(new Set())
      } catch (e: any) {
        setError(e.message)
        setEntries([])
      } finally {
        setLoading(false)
      }
      api.fs.diskFree(serverId, p).then(setFree).catch(() => setFree(null))
    },
    [serverId, conn?.status], // eslint-disable-line
  )

  useEffect(() => {
    if (conn?.status === 'connected' && !path) setPath(win.props.path || server?.defaultPath || conn.home || '/')
  }, [conn?.status]) // eslint-disable-line

  useEffect(() => {
    if (path) {
      load(path)
      setQuery('')
      updateWindow(win.id, { props: { ...win.props, path } })
    }
  }, [path, load]) // eslint-disable-line

  useEffect(() => setFavs(loadFavs(serverId)), [serverId])

  // reload when another window changes this dir
  useEffect(() => {
    const h = (e: Event) => {
      const d = (e as CustomEvent).detail
      if (d.serverId === serverId && (d.dir === path || columns[d.dir])) {
        if (d.dir === path) load(path, true)
        else api.fs.list(serverId, d.dir).then((l) => setColumns((c) => ({ ...c, [d.dir]: l })))
      }
    }
    window.addEventListener('fs-changed', h)
    return () => window.removeEventListener('fs-changed', h)
  }, [serverId, path, load, columns])

  // column view: load each ancestor
  const colPaths = useMemo(() => {
    if (!path) return []
    const parts = path.split('/').filter(Boolean)
    const out = ['/']
    for (let i = 0; i < parts.length; i++) out.push('/' + parts.slice(0, i + 1).join('/'))
    return out
  }, [path])
  useEffect(() => {
    if (view !== 'columns' || conn?.status !== 'connected') return
    for (const p of colPaths) if (!columns[p]) api.fs.list(serverId, p).then((l) => setColumns((c) => ({ ...c, [p]: l }))).catch(() => {})
  }, [view, colPaths]) // eslint-disable-line
  useEffect(() => {
    if (view === 'columns') scrollRef.current?.querySelector('.columns')?.scrollTo({ left: 99999, behavior: 'smooth' })
  }, [view, colPaths.length, sel])

  const visible = useMemo(() => {
    let l = entries
    if (!showHidden) l = l.filter((e) => !e.hidden)
    if (query) l = l.filter((e) => e.name.toLowerCase().includes(query.toLowerCase()))
    return sortEntries(l, sort.key, sort.asc)
  }, [entries, showHidden, query, sort])

  const filterCol = (l: FileEntry[]) => sortEntries(showHidden ? l : l.filter((e) => !e.hidden), 'name', true)

  // ---------- navigation ----------
  const navigate = (p: string) => {
    if (p === path) return
    setHistory((h) => ({ back: [...h.back, path].slice(-50), fwd: [] }))
    setPath(p)
  }
  const goBack = () => {
    const prev = history.back[history.back.length - 1]
    if (!prev) return
    setHistory((h) => ({ back: h.back.slice(0, -1), fwd: [path, ...h.fwd] }))
    setPath(prev)
  }
  const goFwd = () => {
    const next = history.fwd[0]
    if (!next) return
    setHistory((h) => ({ back: [...h.back, path], fwd: h.fwd.slice(1) }))
    setPath(next)
  }

  const switchServer = async (id: string, p?: string) => {
    if (!(await ensureConnected(id))) return
    const st = useStore.getState().conns[id]
    updateWindow(win.id, { serverId: id })
    setHistory({ back: [], fwd: [] })
    setColumns({})
    setEntries([])
    setSel(new Set())
    setPath(p ?? useStore.getState().servers.find((s) => s.id === id)?.defaultPath ?? st?.home ?? '/')
  }

  const selected = visible.filter((e) => sel.has(e.path))
  const allEntries = view === 'columns' ? Object.values(columns).flat() : visible
  const selectedAny = allEntries.filter((e) => sel.has(e.path))
  const items = (list: FileEntry[]): Item[] => list.map((e) => ({ path: e.path, isDir: isDirLike(e) && e.type !== 'link' }))

  const open = (e: FileEntry) => {
    if (isDirLike(e)) navigate(e.path)
    else openEntry(serverId, e)
  }

  // ---------- operations ----------
  const refresh = (dirs: string[] = [path]) => {
    for (const d of new Set(dirs)) fsChanged(serverId, d)
  }
  const run = async (label: string, fn: () => Promise<unknown>) => {
    try {
      await fn()
    } catch (e: any) {
      toast({ title: label, body: e.message, kind: 'error' })
    }
  }

  const newFolder = async (dir = path) => {
    const existing = new Set((columns[dir] ?? entries).map((e) => e.name))
    let name = 'untitled folder'
    for (let i = 2; existing.has(name); i++) name = `untitled folder ${i}`
    await run("Couldn't create folder", async () => {
      await api.fs.mkdir(serverId, joinPath(dir, name))
      refresh([dir])
      await load(dir, true)
      setSel(new Set([joinPath(dir, name)]))
      setRenaming(joinPath(dir, name))
    })
  }

  const newFile = async () => {
    const name = await prompt('New File', 'untitled.txt', 'Enter a name for the new file', 'Create')
    if (!name) return
    await run("Couldn't create file", async () => {
      await api.fs.writeText(serverId, joinPath(path, name), '')
      refresh()
      openInEditor(serverId, joinPath(path, name))
    })
  }

  const commitRename = async (e: FileEntry, name: string) => {
    setRenaming(null)
    if (!name || name === e.name || name.includes('/')) return
    await run(`Couldn't rename “${e.name}”`, async () => {
      const to = joinPath(parentPath(e.path), name)
      await api.fs.rename(serverId, e.path, to)
      refresh([parentPath(e.path)])
      setSel(new Set([to]))
    })
  }

  const remove = async (list: FileEntry[]) => {
    if (!list.length) return
    const ok = await confirm(
      list.length === 1 ? `Are you sure you want to delete “${list[0].name}”?` : `Are you sure you want to delete ${list.length} items?`,
      'This item will be deleted immediately from the server. You can’t undo this action.',
      'Delete',
      true,
    )
    if (!ok) return
    await run('Delete failed', async () => {
      await api.fs.remove(serverId, items(list))
      refresh([...list.map((e) => parentPath(e.path))])
    })
  }

  const duplicate = async (list: FileEntry[]) => {
    await run('Duplicate failed', async () => {
      await api.fs.copy({ serverId, items: items(list) }, { serverId, dir: parentPath(list[0].path) }, false)
      refresh([parentPath(list[0].path)])
    })
  }

  const setClipboard = (list: FileEntry[], cut: boolean) => {
    if (!list.length) return
    useStore.setState({ clipboard: { serverId, items: items(list), cut } })
  }

  const paste = async (dir = path) => {
    const cb = useStore.getState().clipboard
    if (!cb) return
    await run('Paste failed', async () => {
      await api.fs.copy({ serverId: cb.serverId, items: cb.items }, { serverId, dir }, cb.cut)
      if (cb.cut) {
        useStore.setState({ clipboard: undefined })
        fsChanged(cb.serverId, parentPath(cb.items[0].path))
      }
      refresh([dir])
    })
  }

  const download = (list: FileEntry[], choose = false) =>
    run('Download failed', () => (choose ? api.fs.downloadTo(serverId, items(list)) : api.fs.download(serverId, items(list))))

  const upload = (dir = path) =>
    run('Upload failed', async () => {
      if (await api.fs.uploadDialog(serverId, dir)) refresh([dir])
    })

  const compress = async (list: FileEntry[]) => {
    const name = list.length === 1 ? `${list[0].name}.tar.gz` : 'Archive.tar.gz'
    await run('Compress failed', async () => {
      const r = await api.exec(serverId, `cd ${shq(path)} && tar czf ${shq(name)} -- ${list.map((e) => shq(e.name)).join(' ')}`, 600000)
      if (r.code !== 0) throw new Error(r.stderr)
      refresh()
    })
  }

  const extract = async (e: FileEntry) => {
    const x = e.name.toLowerCase()
    const cmd = x.endsWith('.zip')
      ? `unzip -o ${shq(e.name)}`
      : /\.(tar\.gz|tgz|tar\.bz2|tar\.xz|tar)$/.test(x)
        ? `tar xf ${shq(e.name)}`
        : x.endsWith('.gz')
          ? `gunzip -k ${shq(e.name)}`
          : null
    if (!cmd) return toast({ title: 'Unsupported archive format' })
    await run('Extract failed', async () => {
      const r = await api.exec(serverId, `cd ${shq(parentPath(e.path))} && ${cmd}`, 600000)
      if (r.code !== 0) throw new Error(r.stderr)
      refresh([parentPath(e.path)])
    })
  }

  const goToFolder = async () => {
    const p = await prompt('Go to the folder:', path, 'Enter a path. ~ is your home folder.', 'Go')
    if (!p) return
    const target = p.startsWith('~') ? home + p.slice(1) : p.startsWith('/') ? p : joinPath(path, p)
    navigate(target.replace(/\/+$/, '') || '/')
  }

  const addFav = (p: string) => {
    const n = [...new Set([...favs, p])]
    setFavs(n)
    saveFavs(serverId, n)
  }
  const removeFav = (p: string) => {
    const n = favs.filter((f) => f !== p)
    setFavs(n)
    saveFavs(serverId, n)
  }

  // ---------- selection ----------
  const clickItem = (e: React.MouseEvent, entry: FileEntry, list: FileEntry[]) => {
    if (modKey(e)) {
      const n = new Set(sel)
      n.has(entry.path) ? n.delete(entry.path) : n.add(entry.path)
      setSel(n)
      setAnchor(entry.path)
    } else if (e.shiftKey && anchor) {
      const a = list.findIndex((x) => x.path === anchor)
      const b = list.findIndex((x) => x.path === entry.path)
      if (a >= 0 && b >= 0) setSel(new Set(list.slice(Math.min(a, b), Math.max(a, b) + 1).map((x) => x.path)))
    } else if (!sel.has(entry.path) || e.button === 0) {
      if (!(sel.has(entry.path) && e.button !== 0)) setSel(new Set([entry.path]))
      setAnchor(entry.path)
    }
  }

  // ---------- keyboard ----------
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (renaming || (e.target as HTMLElement).tagName === 'INPUT') return
    const list = view === 'columns' ? filterCol(columns[selectedAny.length ? parentPath(selectedAny[0].path) : path] ?? []) : visible
    const idx = list.findIndex((x) => x.path === (anchor ?? ''))
    const cols = view === 'icons' ? Math.max(1, Math.floor(((scrollRef.current?.clientWidth ?? 600) - 28) / 100)) : 1
    const move = (d: number) => {
      const n = list[Math.max(0, Math.min(list.length - 1, idx < 0 ? 0 : idx + d))]
      if (!n) return
      if (e.shiftKey) setSel(new Set([...sel, n.path]))
      else setSel(new Set([n.path]))
      setAnchor(n.path)
      scrollRef.current?.querySelector(`[data-path="${CSS.escape(n.path)}"]`)?.scrollIntoView({ block: 'nearest' })
    }
    const cur = list[idx]
    const k = e.key
    const meta = modKey(e)
    if (k === 'ArrowDown' && meta) { e.preventDefault(); selectedAny[0] && open(selectedAny[0]) }
    else if (k === 'ArrowUp' && meta) { e.preventDefault(); navigate(parentPath(path)) }
    else if (k === 'ArrowDown') { e.preventDefault(); move(cols) }
    else if (k === 'ArrowUp') { e.preventDefault(); move(-cols) }
    else if (k === 'ArrowRight' && view === 'icons') { e.preventDefault(); move(1) }
    else if (k === 'ArrowLeft' && view === 'icons') { e.preventDefault(); move(-1) }
    else if (k === 'ArrowRight' && view === 'columns' && cur && isDirLike(cur)) { e.preventDefault(); navigate(cur.path) }
    else if (k === 'ArrowLeft' && view === 'columns') { e.preventDefault(); const p = cur ? parentPath(cur.path) : path; if (p !== '/') { setSel(new Set([p])); setAnchor(p); navigate(parentPath(p)) } }
    else if ((k === 'Enter' || (k === 'F2' && !isMac)) && selectedAny.length === 1) { e.preventDefault(); setRenaming(selectedAny[0].path) }
    else if (k === 'o' && meta) { e.preventDefault(); selectedAny.forEach(open) }
    else if (k === ' ' ) { e.preventDefault(); selectedAny[0] && quickLook(serverId, selectedAny[0]) }
    else if ((k === 'Backspace' && meta) || (k === 'Delete' && !isMac)) { e.preventDefault(); remove(selectedAny) }
    else if (k === 'a' && meta) { e.preventDefault(); setSel(new Set(visible.map((x) => x.path))) }
    else if (k === 'c' && meta && selectedAny.length) { e.preventDefault(); setClipboard(selectedAny, false) }
    else if (k === 'x' && meta && selectedAny.length) { e.preventDefault(); setClipboard(selectedAny, true) }
    else if (k === 'v' && meta) { e.preventDefault(); paste() }
    else if (k === 'd' && meta && selectedAny.length) { e.preventDefault(); duplicate(selectedAny) }
    else if (k === 'i' && meta && selectedAny[0]) { e.preventDefault(); getInfo(serverId, selectedAny[0]) }
    else if (k === 'N' && meta && e.shiftKey) { e.preventDefault(); newFolder() }
    else if (k === '[' && meta) { e.preventDefault(); goBack() }
    else if (k === ']' && meta) { e.preventDefault(); goFwd() }
    else if (k === 'r' && meta) { e.preventDefault(); load(path, true) }
    else if (k === '1' && meta) { e.preventDefault(); changeView('icons') }
    else if (k === '2' && meta) { e.preventDefault(); changeView('list') }
    else if (k === '3' && meta) { e.preventDefault(); changeView('columns') }
    else if (k === 'Escape') setSel(new Set())
    else if (k.length === 1 && !meta && !e.ctrlKey) {
      // type to select
      const now = Date.now()
      typeAhead.current.s = now - typeAhead.current.t > 900 ? k.toLowerCase() : typeAhead.current.s + k.toLowerCase()
      typeAhead.current.t = now
      const m = list.find((x) => x.name.toLowerCase().startsWith(typeAhead.current.s))
      if (m) {
        setSel(new Set([m.path]))
        setAnchor(m.path)
        scrollRef.current?.querySelector(`[data-path="${CSS.escape(m.path)}"]`)?.scrollIntoView({ block: 'nearest' })
      }
    }
  }

  useWinAction(win.id, (a) => {
    if (a === 'go-home') navigate(home)
    else if (a === 'go-root') navigate('/')
    else if (a === 'go-folder') goToFolder()
    else if (a === 'new-tab') launch('finder', { serverId, forceNew: true, props: { path } })
  })

  const changeView = (v: View) => {
    setView(v)
    try { localStorage.setItem('finder:view', v) } catch { /* ignore */ }
  }

  // ---------- context menus ----------
  const itemMenu = (e: React.MouseEvent, entry: FileEntry) => {
    const list = sel.has(entry.path) ? selectedAny : [entry]
    if (!sel.has(entry.path)) {
      setSel(new Set([entry.path]))
      setAnchor(entry.path)
    }
    const single = list.length === 1 ? list[0] : null
    const dir = single && isDirLike(single)
    const isArchive = single && /\.(zip|tar|tgz|gz|bz2|xz)$/i.test(single.name)
    const m: MenuItem[] = [
      { label: 'Open', shortcut: '⌘O', onClick: () => list.forEach(open) },
      ...(single && !dir
        ? [
            { label: 'Open in Code Editor', onClick: () => openInEditor(serverId, single.path) },
            { label: 'Open with Mac App', onClick: () => run('Open failed', () => api.fs.openLocally(serverId, single.path)) },
          ]
        : []),
      ...(dir ? [{ label: 'Open in New Window', onClick: () => launch('finder', { serverId, forceNew: true, props: { path: single!.path } }) }] : []),
      ...(dir && isSSH ? [{ label: 'New Terminal at Folder', onClick: () => launch('terminal', { serverId, forceNew: true, props: { cwd: single!.path } }) }] : []),
      { separator: true },
      { label: 'Get Info', shortcut: '⌘I', onClick: () => list.forEach((x) => getInfo(serverId, x)) },
      { label: 'Rename', disabled: !single, onClick: () => single && setRenaming(single.path) },
      ...(isSSH ? [{ label: 'Duplicate', shortcut: '⌘D', onClick: () => duplicate(list) }] : []),
      ...(isSSH ? [{ label: `Compress ${single ? `“${single.name}”` : `${list.length} Items`}`, onClick: () => compress(list) }] : []),
      ...(isSSH && isArchive ? [{ label: 'Extract Here', onClick: () => extract(single!) }] : []),
      { label: 'Quick Look', shortcut: '␣', disabled: !single, onClick: () => single && quickLook(serverId, single) },
      { separator: true },
      { label: 'Copy', shortcut: '⌘C', onClick: () => setClipboard(list, false) },
      { label: 'Cut', shortcut: '⌘X', onClick: () => setClipboard(list, true) },
      { label: 'Copy Path', onClick: () => api.copyText(list.map((x) => x.path).join('\n')) },
      ...(dir ? [{ label: favs.includes(single!.path) ? 'Remove from Sidebar' : 'Add to Sidebar', onClick: () => (favs.includes(single!.path) ? removeFav(single!.path) : addFav(single!.path)) }] : []),
      { separator: true },
      { label: 'Download', icon: <Download size={14} />, onClick: () => download(list) },
      { label: 'Download To…', onClick: () => download(list, true) },
      { separator: true },
      { label: 'Delete Immediately…', shortcut: '⌘⌫', danger: true, onClick: () => remove(list) },
    ]
    menu.open(e, m)
  }

  const bgMenu = (e: React.MouseEvent, dir = path) => {
    if ((e.target as HTMLElement).closest('[data-path]')) return
    setSel(new Set())
    menu.open(e, [
      { label: 'New Folder', shortcut: '⇧⌘N', onClick: () => newFolder(dir) },
      { label: 'New File…', onClick: newFile },
      { label: 'Upload Files…', onClick: () => upload(dir) },
      { label: 'Paste', shortcut: '⌘V', disabled: !clipboard, onClick: () => paste(dir) },
      { separator: true },
      { label: 'Get Info', onClick: () => api.fs.stat(serverId, dir).then((x) => getInfo(serverId, { ...x, name: baseName(dir) })) },
      ...(isSSH ? [{ label: 'New Terminal Here', onClick: () => launch('terminal', { serverId, forceNew: true, props: { cwd: dir } }) }] : []),
      { label: 'Copy Path', onClick: () => api.copyText(dir) },
      { separator: true },
      { header: 'View' },
      { label: 'as Icons', checked: view === 'icons', onClick: () => changeView('icons') },
      { label: 'as List', checked: view === 'list', onClick: () => changeView('list') },
      { label: 'as Columns', checked: view === 'columns', onClick: () => changeView('columns') },
      { separator: true },
      { header: 'Sort By' },
      ...(['name', 'kind', 'modified', 'size'] as SortKey[]).map((k) => ({
        label: k === 'modified' ? 'Date Modified' : k[0].toUpperCase() + k.slice(1),
        checked: sort.key === k,
        onClick: () => setSort({ key: k, asc: k === 'name' || k === 'kind' }),
      })),
      { separator: true },
      { label: 'Show Hidden Files', shortcut: '⇧⌘.', checked: showHidden, onClick: () => updateSettings({ showHiddenFiles: !showHidden }) },
      { label: 'Refresh', shortcut: '⌘R', onClick: () => load(path, true) },
    ])
  }

  // ---------- drag & drop ----------
  const onDragStart = (e: React.DragEvent, entry: FileEntry) => {
    const list = sel.has(entry.path) ? selectedAny : [entry]
    if (!sel.has(entry.path)) setSel(new Set([entry.path]))
    e.dataTransfer.setData(DRAG_MIME, JSON.stringify({ serverId, items: items(list) }))
    e.dataTransfer.setData('text/plain', list.map((x) => x.path).join('\n'))
    e.dataTransfer.effectAllowed = 'copyMove'
  }

  const handleDrop = async (e: React.DragEvent, dir: string) => {
    e.preventDefault()
    e.stopPropagation()
    setDropTarget(null)
    setDragOver(false)
    const internal = e.dataTransfer.getData(DRAG_MIME)
    if (internal) {
      const src = JSON.parse(internal) as { serverId: string; items: Item[] }
      if (src.items.some((i) => i.path === dir || dir.startsWith(i.path + '/'))) return
      if (src.serverId === serverId && src.items.every((i) => parentPath(i.path) === dir)) return
      const move = src.serverId === serverId && !e.altKey
      await run(move ? 'Move failed' : 'Copy failed', async () => {
        await api.fs.copy(src, { serverId, dir }, move)
        refresh([dir])
        if (move) fsChanged(src.serverId, parentPath(src.items[0].path))
      })
      return
    }
    const files = [...e.dataTransfer.files].map((f) => api.pathForFile(f)).filter(Boolean)
    if (files.length)
      await run('Upload failed', async () => {
        await api.fs.upload(serverId, files, dir)
        refresh([dir])
      })
  }

  const dropProps = (dir: string, key: string) => ({
    onDragOver: (e: React.DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      e.dataTransfer.dropEffect = e.altKey ? 'copy' : 'move'
      setDropTarget(key)
    },
    onDragLeave: () => setDropTarget((t) => (t === key ? null : t)),
    onDrop: (e: React.DragEvent) => handleDrop(e, dir),
  })

  // ---------- marquee ----------
  const startMarquee = (e: React.MouseEvent) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('[data-path], th')) return
    const host = scrollRef.current!
    const r = host.getBoundingClientRect()
    const x0 = e.clientX - r.left + host.scrollLeft
    const y0 = e.clientY - r.top + host.scrollTop
    const base = modKey(e) || e.shiftKey ? new Set(sel) : new Set<string>()
    if (!modKey(e) && !e.shiftKey) setSel(new Set())
    let moved = false
    const mv = (ev: MouseEvent) => {
      const x1 = ev.clientX - r.left + host.scrollLeft
      const y1 = ev.clientY - r.top + host.scrollTop
      if (!moved && Math.abs(x1 - x0) + Math.abs(y1 - y0) < 4) return
      moved = true
      setMarquee({ x0, y0, x1, y1 })
      const L = Math.min(x0, x1) + r.left - host.scrollLeft
      const R = Math.max(x0, x1) + r.left - host.scrollLeft
      const T = Math.min(y0, y1) + r.top - host.scrollTop
      const B = Math.max(y0, y1) + r.top - host.scrollTop
      const n = new Set(base)
      host.querySelectorAll<HTMLElement>('[data-path]').forEach((el) => {
        const b = el.getBoundingClientRect()
        if (b.right > L && b.left < R && b.bottom > T && b.top < B) n.add(el.dataset.path!)
      })
      setSel(n)
    }
    const up = () => {
      window.removeEventListener('mousemove', mv)
      window.removeEventListener('mouseup', up)
      setMarquee(null)
    }
    window.addEventListener('mousemove', mv)
    window.addEventListener('mouseup', up)
  }

  // ---------- render helpers ----------
  const cutSet = new Set(clipboard?.cut && clipboard.serverId === serverId ? clipboard.items.map((i) => i.path) : [])
  const nameNode = (entry: FileEntry) =>
    renaming === entry.path ? (
      <RenameInput entry={entry} onDone={(n) => commitRename(entry, n)} />
    ) : (
      <span>{entry.name}</span>
    )
  const itemProps = (entry: FileEntry, list: FileEntry[]) => ({
    'data-path': entry.path,
    draggable: renaming !== entry.path,
    onDragStart: (e: React.DragEvent) => onDragStart(e, entry),
    onMouseDown: (e: React.MouseEvent) => clickItem(e, entry, list),
    onDoubleClick: () => open(entry),
    onContextMenu: (e: React.MouseEvent) => itemMenu(e, entry),
    ...(isDirLike(entry) ? dropProps(entry.path, entry.path) : {}),
  })

  const title = path === '/' ? (server?.name ?? '/') : path === home ? baseName(home) : baseName(path)
  const crumbs = path ? colPaths : []

  // ---------- not connected ----------
  if (!conn || conn.status !== 'connected') {
    return (
      <div className="split">
        {renderSidebar()}
        <div className="empty">
          {conn?.status === 'connecting' ? <Spinner size={24} /> : <ServerIcon size={40} strokeWidth={1.3} />}
          <h3>{conn?.status === 'connecting' ? `Connecting to ${server?.name}…` : `${server?.name ?? 'Server'} is not connected`}</h3>
          {conn?.error && conn.error !== 'NEED_PASSWORD' && <div className="small">{conn.error}</div>}
          {conn?.status !== 'connecting' && (
            <button className="btn primary lg" onClick={() => ensureConnected(serverId)}>Connect</button>
          )}
        </div>
      </div>
    )
  }

  function renderSidebar() {
    const fav = (p: string, label: string, Icon: any, removable = false) => (
      <div
        key={p}
        className={`sb-item ${path === p ? 'active' : ''} ${dropTarget === 'sb:' + p ? 'drop' : ''}`}
        onClick={() => navigate(p)}
        onContextMenu={(e) =>
          menu.open(e, [
            { label: 'Open in New Window', onClick: () => launch('finder', { serverId, forceNew: true, props: { path: p } }) },
            ...(removable ? [{ label: 'Remove from Sidebar', onClick: () => removeFav(p) }] : []),
          ])
        }
        {...dropProps(p, 'sb:' + p)}
      >
        <Icon size={16} className="ico" />
        <span className="grow">{label}</span>
      </div>
    )
    return (
      <div className="sidebar">
        <div className="sb-section">Favorites</div>
        {fav(home, baseName(home) === '/' ? 'Home' : baseName(home), Home)}
        {fav('/', 'Computer', Monitor)}
        {isSSH && fav('/etc', 'Config', Settings2)}
        {isSSH && fav('/var/log', 'Logs', ScrollText)}
        {isSSH && fav('/tmp', 'Temporary', Clock)}
        {favs.map((f) => fav(f, baseName(f), Star, true))}
        <div className="sb-section">Locations</div>
        {servers.map((s) => {
          const st = conns[s.id]?.status ?? 'disconnected'
          return (
            <div
              key={s.id}
              className={`sb-item ${s.id === serverId && path === (conns[s.id]?.home ?? '/') ? 'active' : ''} ${dropTarget === 'srv:' + s.id ? 'drop' : ''}`}
              onClick={() => (s.id === serverId ? navigate(home) : switchServer(s.id))}
              title={`${s.username}@${s.host}:${s.port} (${s.protocol.toUpperCase()})`}
              onDragOver={(e) => {
                if (st !== 'connected') return
                e.preventDefault()
                setDropTarget('srv:' + s.id)
              }}
              onDragLeave={() => setDropTarget(null)}
              onDrop={async (e) => {
                e.preventDefault()
                setDropTarget(null)
                const internal = e.dataTransfer.getData(DRAG_MIME)
                const home2 = conns[s.id]?.home ?? '/'
                if (internal) {
                  const src = JSON.parse(internal)
                  await run('Copy failed', () => api.fs.copy(src, { serverId: s.id, dir: home2 }, false))
                  fsChanged(s.id, home2)
                } else {
                  const files = [...e.dataTransfer.files].map((f) => api.pathForFile(f))
                  await run('Upload failed', () => api.fs.upload(s.id, files, home2))
                  fsChanged(s.id, home2)
                }
              }}
              onContextMenu={(e) =>
                menu.open(e, [
                  { label: 'Open in New Window', onClick: () => launch('finder', { serverId: s.id, forceNew: true }) },
                  ...(s.protocol === 'ssh' ? [{ label: 'New Terminal', onClick: () => launch('terminal', { serverId: s.id, forceNew: true }) }] : []),
                  { separator: true },
                  st === 'connected'
                    ? { label: 'Disconnect', onClick: () => disconnectServer(s.id) }
                    : { label: 'Connect', onClick: () => ensureConnected(s.id) },
                ])
              }
            >
              {s.protocol === 'ssh' ? <HardDrive size={16} className="ico" style={{ color: s.color }} /> : <Globe size={16} className="ico" style={{ color: s.color }} />}
              <span className="grow">{s.name}</span>
              {st === 'connected' ? (
                <button className="eject" title="Disconnect" onClick={(e) => { e.stopPropagation(); disconnectServer(s.id) }}>
                  <Eject size={12} />
                </button>
              ) : (
                <span className={`status-dot ${st}`} />
              )}
            </div>
          )
        })}
        <div className="sb-item" style={{ color: 'var(--text-2)' }} onClick={() => launch('servers', { props: { addNew: true } })}>
          <FolderOpen size={16} className="ico" style={{ color: 'var(--text-3)' }} />
          <span className="grow">Connect to Server…</span>
        </div>
      </div>
    )
  }

  return (
    <>
      <Toolbar>
        <div className="row" style={{ gap: 2, marginLeft: 100 }}>
          <button className="tb-btn" disabled={!history.back.length} onClick={goBack} title="Back">
            <ChevronLeft size={20} />
          </button>
          <button className="tb-btn" disabled={!history.fwd.length} onClick={goFwd} title="Forward">
            <ChevronRight size={20} />
          </button>
        </div>
        <div className="toolbar-title" style={{ flex: 1, minWidth: 60 }}>{title}</div>
        {loading && <Spinner size={14} />}
        <div className="tb-group">
          <button className={`tb-btn ${view === 'icons' ? 'on' : ''}`} onClick={() => changeView('icons')} title="Icons">
            <LayoutGrid size={15} />
          </button>
          <button className={`tb-btn ${view === 'list' ? 'on' : ''}`} onClick={() => changeView('list')} title="List">
            <List size={16} />
          </button>
          <button className={`tb-btn ${view === 'columns' ? 'on' : ''}`} onClick={() => changeView('columns')} title="Columns">
            <Columns3 size={15} />
          </button>
        </div>
        <button className="tb-btn" title="New Folder" onClick={() => newFolder()}>
          <FolderPlus size={17} />
        </button>
        <button className="tb-btn" title="Upload" onClick={() => upload()}>
          <ArrowUpFromLine size={17} />
        </button>
        <button className="tb-btn" title="Download" disabled={!selectedAny.length} onClick={() => download(selectedAny)}>
          <Download size={17} />
        </button>
        <button className="tb-btn" title="Delete" disabled={!selectedAny.length} onClick={() => remove(selectedAny)}>
          <Trash2 size={16} />
        </button>
        {isSSH && (
          <button className="tb-btn" title="Open Terminal Here" onClick={() => launch('terminal', { serverId, forceNew: true, props: { cwd: path } })}>
            <TermIcon size={16} />
          </button>
        )}
        <button className="tb-btn" title="More" onClick={(e) => bgMenu({ ...e, target: e.currentTarget } as any)}>
          <Ellipsis size={17} />
        </button>
        <div className="search">
          <Search size={13} />
          <input placeholder="Search" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setQuery('')} />
        </div>
      </Toolbar>
      <div className="split">
        {renderSidebar()}
        <div
          className={`finder-main ${dragOver && !dropTarget ? 'drag-over' : ''}`}
          onDragOver={(e) => {
            e.preventDefault()
            setDragOver(true)
          }}
          onDragLeave={(e) => {
            if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) setDragOver(false)
          }}
          onDrop={(e) => handleDrop(e, path)}
        >
          <div
            ref={scrollRef}
            className="file-scroll"
            tabIndex={0}
            onKeyDown={onKeyDown}
            onMouseDown={startMarquee}
            onContextMenu={(e) => bgMenu(e)}
          >
            {error ? (
              <div className="empty">
                <h3>Can’t open this folder</h3>
                <div>{error}</div>
                <button className="btn" onClick={() => navigate(parentPath(path))}>Go to Enclosing Folder</button>
              </div>
            ) : view === 'list' ? (
              <table className="list-table">
                <colgroup>
                  <col style={{ width: '46%' }} />
                  <col style={{ width: '24%' }} />
                  <col style={{ width: '12%' }} />
                  <col style={{ width: '18%' }} />
                </colgroup>
                <thead className="list-head">
                  <tr>
                    {(['name', 'modified', 'size', 'kind'] as SortKey[]).map((k) => (
                      <th key={k} className={sort.key === k ? 'sorted' : ''} onClick={() => setSort((s) => ({ key: k, asc: s.key === k ? !s.asc : true }))} style={k === 'size' ? { textAlign: 'right' } : undefined}>
                        {k === 'modified' ? 'Date Modified' : k[0].toUpperCase() + k.slice(1)}
                        {sort.key === k && <span style={{ marginLeft: 4, fontSize: 9 }}>{sort.asc ? '▲' : '▼'}</span>}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {visible.map((entry) => (
                    <tr
                      key={entry.path}
                      className={`list-row ${sel.has(entry.path) ? 'sel' : ''} ${dropTarget === entry.path ? 'drop' : ''} ${cutSet.has(entry.path) ? 'cut' : ''} ${entry.hidden ? 'hidden-file' : ''}`}
                      {...itemProps(entry, visible)}
                    >
                      <td>
                        <div className="name-cell">
                          <FileIcon cat={category(entry)} size={17} />
                          {nameNode(entry)}
                        </div>
                      </td>
                      <td>{formatDate(entry.modified)}</td>
                      <td style={{ textAlign: 'right' }}>{isDirLike(entry) ? '--' : formatBytes(entry.size)}</td>
                      <td>{kindLabel(entry)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : view === 'icons' ? (
              <div className="grid">
                {visible.map((entry) => (
                  <div
                    key={entry.path}
                    className={`grid-item ${sel.has(entry.path) ? 'sel' : ''} ${dropTarget === entry.path ? 'drop' : ''} ${cutSet.has(entry.path) ? 'cut' : ''} ${entry.hidden ? 'hidden-file' : ''}`}
                    {...itemProps(entry, visible)}
                  >
                    <div className="icon-wrap">
                      <FileIcon cat={category(entry)} size={56} label={ext(entry.name)} />
                    </div>
                    {renaming === entry.path ? <RenameInput entry={entry} onDone={(n) => commitRename(entry, n)} /> : <div className="gname">{entry.name}</div>}
                  </div>
                ))}
              </div>
            ) : (
              <div className="columns">
                {colPaths.map((cp, ci) => {
                  const list = filterCol(columns[cp] ?? [])
                  const nextInTrail = colPaths[ci + 1]
                  return (
                    <div key={cp} className="column" onContextMenu={(e) => bgMenu(e, cp)} {...dropProps(cp, 'col:' + cp)}>
                      {!columns[cp] && <div style={{ padding: 10 }}><Spinner size={12} /></div>}
                      {list.map((entry) => (
                        <div
                          key={entry.path}
                          className={`col-row ${sel.has(entry.path) ? 'sel' : entry.path === nextInTrail ? 'trail' : ''} ${cutSet.has(entry.path) ? 'cut' : ''}`}
                          {...itemProps(entry, list)}
                          onMouseDown={(e) => {
                            clickItem(e, entry, list)
                            if (e.button === 0 && !modKey(e) && !e.shiftKey) {
                              if (isDirLike(entry)) navigate(entry.path)
                              else if (parentPath(entry.path) !== path) navigate(parentPath(entry.path))
                            }
                          }}
                          onDoubleClick={() => !isDirLike(entry) && open(entry)}
                        >
                          <FileIcon cat={category(entry)} size={16} />
                          {renaming === entry.path ? <RenameInput entry={entry} onDone={(n) => commitRename(entry, n)} /> : <span>{entry.name}</span>}
                          {isDirLike(entry) && <ChevronRight size={12} style={{ opacity: 0.5 }} />}
                        </div>
                      ))}
                    </div>
                  )
                })}
                {selectedAny.length === 1 && !isDirLike(selectedAny[0]) && (
                  <div className="col-preview">
                    <FileIcon cat={category(selectedAny[0])} size={110} label={ext(selectedAny[0].name)} />
                    <b style={{ wordBreak: 'break-all' }}>{selectedAny[0].name}</b>
                    <div className="muted small">{kindLabel(selectedAny[0])} — {formatBytes(selectedAny[0].size)}</div>
                    <div className="muted small">Modified {formatDate(selectedAny[0].modified)}</div>
                    {selectedAny[0].permissions && <div className="muted small mono">{selectedAny[0].permissions} {selectedAny[0].owner}:{selectedAny[0].group}</div>}
                    <div className="row" style={{ marginTop: 8 }}>
                      <button className="btn" onClick={() => open(selectedAny[0])}>Open</button>
                      <button className="btn" onClick={() => quickLook(serverId, selectedAny[0], false)}>Quick Look</button>
                    </div>
                  </div>
                )}
              </div>
            )}
            {!error && !loading && visible.length === 0 && view !== 'columns' && (
              <div className="empty" style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
                {query ? `No results for “${query}”` : 'This folder is empty'}
              </div>
            )}
            {marquee && (
              <div
                className="marquee"
                style={{
                  left: Math.min(marquee.x0, marquee.x1),
                  top: Math.min(marquee.y0, marquee.y1),
                  width: Math.abs(marquee.x1 - marquee.x0),
                  height: Math.abs(marquee.y1 - marquee.y0),
                }}
              />
            )}
          </div>
          <div className="pathbar">
            <span className="crumb" onClick={() => navigate('/')}>
              {isSSH ? <HardDrive size={12} /> : <Globe size={12} />} {server?.name}
            </span>
            {crumbs.slice(1).map((c) => (
              <span key={c} className="row" style={{ gap: 2 }}>
                <ChevronRight size={10} />
                <span className="crumb" onClick={() => navigate(c)} {...dropProps(c, 'crumb:' + c)}>
                  <FileIcon cat="folder" size={13} /> {baseName(c)}
                </span>
              </span>
            ))}
          </div>
          <div className="statusbar">
            {selectedAny.length > 0 ? `${selectedAny.length} of ${visible.length} selected` : `${visible.length} item${visible.length === 1 ? '' : 's'}`}
            {free !== null && `, ${formatBytes(free)} available`}
          </div>
        </div>
      </div>
      {menu.el}
    </>
  )
}

function RenameInput({ entry, onDone }: { entry: FileEntry; onDone: (name: string) => void }) {
  const ref = useRef<HTMLInputElement>(null)
  const done = useRef(false)
  useEffect(() => {
    const el = ref.current!
    el.focus()
    const dot = entry.name.lastIndexOf('.')
    if (dot > 0 && !isDirLike(entry)) el.setSelectionRange(0, dot)
    else el.select()
  }, [entry])
  const finish = (v: string) => {
    if (done.current) return
    done.current = true
    onDone(v)
  }
  return (
    <input
      ref={ref}
      className="rename-input"
      defaultValue={entry.name}
      onMouseDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') finish(e.currentTarget.value.trim())
        if (e.key === 'Escape') finish(entry.name)
      }}
      onBlur={(e) => finish(e.currentTarget.value.trim())}
    />
  )
}

function Eject({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" fill="currentColor">
      <path d="M6 1.5 10.5 7h-9z" />
      <rect x="1.5" y="8.5" width="9" height="2" rx=".5" />
    </svg>
  )
}
