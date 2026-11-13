import { useEffect, useState } from 'react'
import { ArrowUpCircle, Download, ExternalLink, Package, Power, RefreshCw, Search, Settings2, Star, Trash2, Upload } from 'lucide-react'
import { api, shq } from '../../lib/api'
import { confirm, toast } from '../../lib/store'
import { MC_DIR, fetchCmd, run, safeFileName } from '../../lib/mc/server'
import { TR_FILE, UNZIP_FN, type TrContentRecord } from '../../lib/tr/server'
import {
  latestPluginRelease, modCompat, pluginCompat, searchPlugins, searchWorkshop, tshockMajorDate, TML_APP, TML_TAG, workshopDetails, workshopInstallScript,
  type PluginRelease, type PluginRepo, type WorkshopItem,
} from '../../lib/tr/apis'
import { formatBytes } from '../../lib/files'
import { openInEditor } from '../../lib/actions'
import { Segmented, Spinner } from '../../components/ui'
import { Help } from '../minecraft/common'
import { useTrCtx } from './Terraria'
import { launch } from '../launch'

type Compat = { status: 'ok' | 'incompatible' | 'unknown'; reason?: string }

function CompatBadge({ c, label }: { c?: Compat; label: string }) {
  if (!c || c.status === 'unknown') return null
  return c.status === 'ok'
    ? <span className="badge" style={{ color: 'var(--green)' }}>✓ {label}</span>
    : <span className="badge" style={{ color: 'var(--red)' }} title={c.reason}>Not compatible</span>
}

export function TrContentTab() {
  const { srv } = useTrCtx()
  const [view, setView] = useState<'installed' | 'browse'>('installed')
  const isMods = srv.config.software === 'tmodloader'
  return (
    <>
      <div className="row" style={{ padding: '8px 16px', borderBottom: '1px solid var(--border)', justifyContent: 'center' }}>
        <Segmented value={view} onChange={setView} options={[{ value: 'installed', label: 'Installed' }, { value: 'browse', label: isMods ? 'Steam Workshop' : 'Find Plugins' }]} />
        <Help title={isMods ? 'Mods' : 'Plugins'} text={isMods
          ? 'tModLoader mods are downloaded from the Steam Workshop with SteamCMD and enabled in data/Mods/enabled.json. Players download matching mods automatically when they join. Resource packs are client-side in Terraria; players install them in the game.'
          : 'TShock plugins are .dll files in ServerPlugins/. SSH OS installs them from GitHub releases of projects tagged “tshock-plugin”. Restart the server after installing. Resource packs are client-side in Terraria; players install them in the game.'} />
      </div>
      {isMods ? (view === 'installed' ? <InstalledMods onBrowse={() => setView('browse')} /> : <BrowseMods />) : view === 'installed' ? <InstalledPlugins onBrowse={() => setView('browse')} /> : <BrowsePlugins />}
    </>
  )
}

// ============================================================ shared
function useContentRegistry() {
  const { srv, saveCfg } = useTrCtx()
  const readCfg = async () => {
    try { return JSON.parse(await api.fs.readText(srv.hostId, `${srv.dir}/${MC_DIR}/${TR_FILE}`)) } catch { return srv.config }
  }
  const record = async (file: string, rec: TrContentRecord | null) => {
    if (!srv.managed) return
    const cfg = await readCfg()
    const content = { ...(cfg.content ?? {}) }
    if (rec) content[file] = rec
    else delete content[file]
    await saveCfg({ content } as any)
  }
  return { record }
}

function ConfigFiles({ folder, match, title, onClose }: { folder: string; match: string; title: string; onClose: () => void }) {
  const { srv } = useTrCtx()
  const [files, setFiles] = useState<string[] | null>(null)
  useEffect(() => {
    run(srv.hostId, `cd ${shq(srv.dir)} && [ -d ${shq(folder)} ] && find ${shq(folder)} -maxdepth 3 -type f -size -2M 2>/dev/null | grep -iE '\\.(json|txt|toml|ya?ml|ini|cfg|conf|xml)$' | head -200; true`).then((r) => {
      const all = r.stdout.split('\n').filter(Boolean)
      const m = match.toLowerCase().replace(/\.(dll|tmod).*$/, '').replace(/[^a-z0-9]/g, '')
      const hits = m ? all.filter((f) => f.toLowerCase().replace(/[^a-z0-9/]/g, '').includes(m)) : all
      setFiles(hits.length ? hits : all)
    })
  }, [folder, match]) // eslint-disable-line
  return (
    <div className="modal-backdrop" style={{ position: 'absolute', paddingTop: 30, zIndex: 40 }} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet" style={{ width: 600, maxHeight: '80%', display: 'flex', flexDirection: 'column' }}>
        <h3 style={{ marginBottom: 4 }}>{title} configuration</h3>
        <div className="small muted" style={{ marginBottom: 12 }}>Files in <span className="mono">{folder}/</span>. Restart the server (or use the plugin’s reload command) after editing.</div>
        <div className="grow scroll group-box" style={{ minHeight: 80 }}>
          {files === null ? <div className="group-row"><Spinner size={14} /></div> : files.length === 0 ? <div className="group-row muted">No configuration files yet. They are created on the next server start.</div> : files.map((f) => (
            <div key={f} className="group-row">
              <span className="mono small">{f.slice(folder.length + 1)}</span>
              <button className="btn" onClick={() => { openInEditor(srv.hostId, `${srv.dir}/${f}`); onClose() }}>Edit</button>
            </div>
          ))}
        </div>
        <div className="sheet-actions">
          <button className="btn" onClick={() => launch('finder', { serverId: srv.hostId, forceNew: true, props: { path: `${srv.dir}/${folder}` } })}>Show in Finder</button>
          <button className="btn primary" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  )
}

// ============================================================ TShock plugins
interface InstalledPlugin { file: string; size: number; enabled: boolean; rec?: TrContentRecord; latest?: PluginRelease | null; compat?: Compat }

/** Shell: download a plugin release asset into ServerPlugins (zip → all plugin DLLs inside). */
function pluginInstallScript(dir: string, asset: { name: string; url: string; sha256?: string }) {
  const name = safeFileName(asset.name, 'plugin.dll')
  const check = asset.sha256 ? `if command -v sha256sum >/dev/null; then echo "${asset.sha256}  $T/${name}" | sha256sum -c - >/dev/null || { echo "Checksum mismatch"; exit 4; }; fi` : ''
  return `set -e
${UNZIP_FN}
P=${shq(dir + '/ServerPlugins')}; mkdir -p "$P"
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
echo "Downloading ${name}…"
${fetchCmd(asset.url, `$T/${name}`).replaceAll(`'$T/${name}'`, `"$T/${name}"`)}
${check}
case ${shq(name)} in
  *.zip) mkdir -p "$T/x"; unz "$T/${name}" "$T/x"
         find "$T/x" -name '*.dll' ! -name 'TShockAPI.dll' ! -name 'OTAPI*.dll' ! -name 'TerrariaServer.dll' ! -name 'Newtonsoft.Json.dll' -exec cp -f {} "$P/" \\; -exec sh -c 'echo "Installed $(basename "$1")"' sh {} \\; ;;
  *) cp -f "$T/${name}" "$P/${name}"; echo "Installed ${name}" ;;
esac
echo "Restart the server to load it."`
}

function InstalledPlugins({ onBrowse }: { onBrowse: () => void }) {
  const { srv, task } = useTrCtx()
  const { record } = useContentRegistry()
  const [items, setItems] = useState<InstalledPlugin[] | null>(null)
  const [config, setConfig] = useState<InstalledPlugin | null>(null)
  const ver = srv.config.version

  const load = async () => {
    setItems(null)
    const r = await run(srv.hostId, `cd ${shq(srv.dir)}/ServerPlugins 2>/dev/null && for f in *.dll *.dll.disabled; do [ -f "$f" ] && [ "$f" != TShockAPI.dll ] && echo "$f|$(stat -c %s "$f")"; done; true`)
    const content = srv.config.content ?? {}
    const list: InstalledPlugin[] = r.stdout.split('\n').filter(Boolean).map((l) => {
      const [file, size] = l.split('|')
      return { file, size: +size, enabled: !file.endsWith('.disabled'), rec: content[file.replace(/\.disabled$/, '')] }
    })
    setItems(list)
    // releases & compatibility for plugins installed from GitHub (1 request each)
    const majorDate = await tshockMajorDate(ver).catch(() => undefined)
    const enriched = await Promise.all(list.map(async (p) => {
      if (p.rec?.source !== 'github') return p
      const latest = await latestPluginRelease(p.rec.id)
      return { ...p, latest, compat: pluginCompat(latest, ver, majorDate) }
    }))
    setItems(enriched)
  }
  useEffect(() => { load() }, [srv.dir]) // eslint-disable-line

  const update = async (p: InstalledPlugin) => {
    const asset = p.latest?.assets.find((a) => a.name.toLowerCase().endsWith('.dll')) ?? p.latest?.assets[0]
    if (!asset || !p.rec) return
    const r = await task(`Updating ${p.rec.title}`, pluginInstallScript(srv.dir, asset))
    if (r.code === 0) await record(p.file.replace(/\.disabled$/, ''), { ...p.rec, version: p.latest!.tag })
    load()
  }
  const toggle = async (p: InstalledPlugin) => {
    const to = p.enabled ? p.file + '.disabled' : p.file.replace(/\.disabled$/, '')
    await api.fs.rename(srv.hostId, `${srv.dir}/ServerPlugins/${p.file}`, `${srv.dir}/ServerPlugins/${to}`)
    toast({ title: `${p.enabled ? 'Disabled' : 'Enabled'} ${p.file.replace(/\.dll.*$/, '')}`, body: 'Restart the server to apply.' })
    load()
  }
  const remove = async (p: InstalledPlugin) => {
    if (!(await confirm(`Remove ${p.file.replace(/\.dll.*$/, '')}?`, 'The plugin file is deleted. Its settings in tshock/ are kept.', 'Remove', true))) return
    await api.fs.remove(srv.hostId, [{ path: `${srv.dir}/ServerPlugins/${p.file}`, isDir: false }])
    await record(p.file.replace(/\.disabled$/, ''), null)
    load()
  }

  const updates = (items ?? []).filter((p) => p.latest && p.rec?.version && p.latest.tag !== p.rec.version)
  const bad = (items ?? []).filter((p) => p.enabled && p.compat?.status === 'incompatible')
  return (
    <div className="grow scroll pad" style={{ maxWidth: 900, width: '100%', margin: '0 auto' }}>
      <div className="row" style={{ marginBottom: 12 }}>
        <div className="grow small muted">{items ? `${items.length} plugin${items.length === 1 ? '' : 's'} · TShock ${ver}` : 'Loading…'}</div>
        <button className="btn" onClick={load}><RefreshCw size={12} /></button>
        <button className="btn" onClick={async () => { if (await api.fs.uploadDialog(srv.hostId, `${srv.dir}/ServerPlugins`)) load() }}><Upload size={12} /> Upload .dll…</button>
        {updates.length > 0 && <button className="btn primary" onClick={async () => { for (const p of updates) await update(p) }}>Update All ({updates.length})</button>}
        <button className="btn primary" onClick={onBrowse}><Download size={12} /> Get More</button>
      </div>
      {bad.length > 0 && <div className="card small" style={{ marginBottom: 14, borderLeft: '3px solid var(--red)' }}><b style={{ color: 'var(--red)' }}>{bad.length} plugin{bad.length > 1 ? 's' : ''} may not work with TShock {ver}</b><div className="muted">{bad.map((p) => p.rec?.title ?? p.file).join(', ')}</div></div>}
      <div className="group-box">
        {items === null ? <div className="group-row"><Spinner size={14} /></div> : items.length === 0 ? (
          <div className="empty" style={{ padding: 20 }}><Package size={34} strokeWidth={1.3} /><h3>No plugins yet</h3><button className="btn primary" onClick={onBrowse}>Find Plugins</button></div>
        ) : items.map((p) => {
          const hasUpdate = p.latest && p.rec?.version && p.latest.tag !== p.rec.version
          return (
            <div key={p.file} className="group-row" style={{ opacity: p.enabled ? 1 : 0.55 }}>
              <div className="row" style={{ minWidth: 0, gap: 10 }}>
                <div className="mc-addon-icon"><Package size={16} /></div>
                <div style={{ minWidth: 0 }}>
                  <div className="row" style={{ gap: 6 }}>
                    <b>{p.rec?.title ?? p.file.replace(/\.dll.*$/, '')}</b>
                    {p.rec?.version && <span className="badge">{p.rec.version}</span>}
                    {!p.enabled && <span className="badge">Disabled</span>}
                    {hasUpdate && <span className="badge" style={{ color: 'var(--green)' }}>→ {p.latest!.tag}</span>}
                    {p.enabled && <CompatBadge c={p.compat} label={`TShock ${parseInt(ver) || ver}`} />}
                  </div>
                  <div className="small muted">{p.file} · {formatBytes(p.size, true)}{p.rec ? ` · github.com/${p.rec.id}` : ' · installed manually'}</div>
                  {p.enabled && p.compat?.status === 'incompatible' && <div className="small" style={{ color: 'var(--red)' }}>{p.compat.reason}</div>}
                </div>
              </div>
              <div className="row">
                {hasUpdate && <button className="btn primary" onClick={() => update(p)}><ArrowUpCircle size={12} /> Update</button>}
                <button className="tb-btn" title="Edit configuration" onClick={() => setConfig(p)}><Settings2 size={14} /></button>
                {p.rec && <button className="tb-btn" title="Open on GitHub" onClick={() => api.openExternal(`https://github.com/${p.rec!.id}`)}><ExternalLink size={13} /></button>}
                <button className="tb-btn" title={p.enabled ? 'Disable' : 'Enable'} onClick={() => toggle(p)}><Power size={14} /></button>
                <button className="tb-btn" title="Remove" onClick={() => remove(p)}><Trash2 size={14} /></button>
              </div>
            </div>
          )
        })}
      </div>
      {config && <ConfigFiles folder="tshock" match={config.file} title={config.rec?.title ?? config.file.replace(/\.dll.*$/, '')} onClose={() => setConfig(null)} />}
    </div>
  )
}

function BrowsePlugins() {
  const { srv, task } = useTrCtx()
  const { record } = useContentRegistry()
  const [q, setQ] = useState('')
  const [dq, setDq] = useState('')
  const [hits, setHits] = useState<PluginRepo[] | null>(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [majorDate, setMajorDate] = useState<string | undefined>()
  const ver = srv.config.version

  useEffect(() => { tshockMajorDate(ver).then(setMajorDate).catch(() => {}) }, [ver])
  useEffect(() => { const t = setTimeout(() => setDq(q), 400); return () => clearTimeout(t) }, [q])
  useEffect(() => {
    setHits(null)
    setErr('')
    searchPlugins(dq).then(setHits).catch((e) => { setErr(/403|rate/i.test(e.message) ? 'GitHub search limit reached. Try again in a minute.' : e.message); setHits([]) })
  }, [dq])

  const install = async (h: PluginRepo) => {
    setBusy(h.repo)
    try {
      const rel = await latestPluginRelease(h.repo)
      if (!rel || !rel.assets.length) {
        toast({ title: `${h.title} has no downloadable release`, body: 'Opening the project page; build or download it there and upload the .dll.', action: { label: 'Open', run: () => api.openExternal(h.url) } })
        return
      }
      const c = pluginCompat(rel, ver, majorDate)
      if (c.status === 'incompatible' && !(await confirm(`${h.title} may not work`, `${c.reason} Install anyway?`, 'Install Anyway'))) return
      const asset = rel.assets.find((a) => a.name.toLowerCase().endsWith('.dll')) ?? rel.assets[0]
      const r = await task(`Installing ${h.title} ${rel.tag}`, pluginInstallScript(srv.dir, asset))
      if (r.code === 0) {
        const files = [...r.output.matchAll(/Installed (\S+\.dll)/g)].map((m) => m[1])
        for (const f of files.length ? files : [safeFileName(asset.name)]) await record(f, { source: 'github', id: h.repo, title: h.title, version: rel.tag })
      }
    } catch (e: any) {
      toast({ title: 'Install failed', body: e.message, kind: 'error' })
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      <div className="row" style={{ padding: '8px 16px', borderBottom: '1px solid var(--border)' }}>
        <div className="search grow"><Search size={13} /><input placeholder="Search TShock plugins on GitHub" value={q} onChange={(e) => setQ(e.target.value)} /></div>
      </div>
      <div className="grow scroll pad">
        {err && <div className="empty">{err}</div>}
        {hits === null && <div className="empty"><Spinner size={22} /></div>}
        <div className="mc-results">
          {hits?.map((h) => {
            const stale = majorDate && h.updated < majorDate
            return (
              <div key={h.repo} className="mc-result">
                {h.avatar ? <img src={h.avatar} className="mc-addon-icon lg" alt="" /> : <div className="mc-addon-icon lg"><Package size={22} /></div>}
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="row" style={{ gap: 6 }}>
                    <b>{h.title}</b><span className="small muted">{h.repo.split('/')[0]}</span>
                    {stale && <span className="badge" style={{ color: 'var(--orange)' }} title={`No changes since TShock ${parseInt(ver)} was released`}>Not updated for TShock {parseInt(ver)}</span>}
                  </div>
                  <div className="small muted mc-desc">{h.description || 'No description'}</div>
                  <div className="small muted row" style={{ gap: 10, marginTop: 3 }}><span><Star size={10} /> {h.stars}</span><span>Updated {new Date(h.updated).toLocaleDateString()}</span></div>
                </div>
                <div className="col" style={{ gap: 4 }}>
                  <button className="btn primary" disabled={busy === h.repo} onClick={() => install(h)}>{busy === h.repo ? <Spinner size={11} /> : <Download size={11} />} Install</button>
                  <button className="btn" onClick={() => api.openExternal(h.url)}>GitHub</button>
                </div>
              </div>
            )
          })}
        </div>
        {hits && hits.length === 0 && !err && <div className="empty">No plugins found.</div>}
      </div>
    </>
  )
}

// ============================================================ tModLoader mods
interface InstalledMod { id: string; name: string; enabled: boolean; mtime: number; local?: boolean; details?: WorkshopItem; compat?: Compat }

const ENABLED = 'data/Mods/enabled.json'

function useEnabled() {
  const { srv } = useTrCtx()
  const read = async (): Promise<string[]> => { try { return JSON.parse(await api.fs.readText(srv.hostId, `${srv.dir}/${ENABLED}`)) } catch { return [] } }
  const write = async (list: string[]) => {
    await run(srv.hostId, `mkdir -p ${shq(srv.dir + '/data/Mods')}`)
    await api.fs.writeText(srv.hostId, `${srv.dir}/${ENABLED}`, JSON.stringify([...new Set(list)], null, 2))
  }
  return { read, write }
}

function InstalledMods({ onBrowse }: { onBrowse: () => void }) {
  const { srv, task } = useTrCtx()
  const { record } = useContentRegistry()
  const enabled = useEnabled()
  const [mods, setMods] = useState<InstalledMod[] | null>(null)
  const [config, setConfig] = useState<InstalledMod | null>(null)
  const ws = `steamapps/workshop/content/${TML_APP}`

  const load = async () => {
    setMods(null)
    const r = await run(srv.hostId, `cd ${shq(srv.dir)} && for d in ${ws}/*/; do [ -d "$d" ] || continue; id=$(basename "$d"); f=$(find "$d" -name '*.tmod' | sort | tail -1); echo "W|$id|$(basename "$f" .tmod)|$(stat -c %Y "$d")"; done; for f in data/Mods/*.tmod; do [ -f "$f" ] && echo "L|local|$(basename "$f" .tmod)|$(stat -c %Y "$f")"; done; true`)
    const on = new Set(await enabled.read())
    const list: InstalledMod[] = r.stdout.split('\n').filter(Boolean).map((l) => {
      const [kind, id, name, mtime] = l.split('|')
      return { id, name, enabled: on.has(name), mtime: +mtime * 1000, local: kind === 'L' }
    })
    setMods(list)
    const details = await workshopDetails(list.filter((m) => !m.local).map((m) => m.id)).catch(() => [])
    setMods(list.map((m) => { const d = details.find((x) => x.id === m.id); return d ? { ...m, details: d, compat: modCompat(d.tags) } : m }))
  }
  useEffect(() => { load() }, [srv.dir]) // eslint-disable-line

  const toggle = async (m: InstalledMod) => {
    const list = await enabled.read()
    await enabled.write(m.enabled ? list.filter((x) => x !== m.name) : [...list, m.name])
    toast({ title: `${m.enabled ? 'Disabled' : 'Enabled'} ${m.details?.title ?? m.name}`, body: 'Restart the server to apply.' })
    load()
  }
  const remove = async (m: InstalledMod) => {
    if (!(await confirm(`Remove ${m.details?.title ?? m.name}?`, 'The mod files are deleted and it is disabled.', 'Remove', true))) return
    await run(srv.hostId, `cd ${shq(srv.dir)} && rm -rf -- ${m.local ? shq(`data/Mods/${m.name}.tmod`) : shq(`${ws}/${m.id}`)}`)
    await enabled.write((await enabled.read()).filter((x) => x !== m.name))
    await record(m.id, null)
    load()
  }
  const updateAll = async () => {
    const ids = (mods ?? []).filter((m) => !m.local).map((m) => m.id)
    if (!ids.length) return
    await task(`Updating ${ids.length} mod${ids.length > 1 ? 's' : ''}`, workshopInstallScript(srv.dir, ids) + '\necho "Restart the server to load the new versions."')
    load()
  }

  const outdated = (mods ?? []).filter((m) => m.details && m.details.updated > m.mtime + 60000)
  const bad = (mods ?? []).filter((m) => m.enabled && m.compat?.status === 'incompatible')
  return (
    <div className="grow scroll pad" style={{ maxWidth: 900, width: '100%', margin: '0 auto' }}>
      <div className="row" style={{ marginBottom: 12 }}>
        <div className="grow small muted">{mods ? `${mods.length} mod${mods.length === 1 ? '' : 's'} · tModLoader ${srv.config.version}` : 'Loading…'}</div>
        <button className="btn" onClick={load}><RefreshCw size={12} /></button>
        <button className="btn" onClick={async () => { if (await api.fs.uploadDialog(srv.hostId, `${srv.dir}/data/Mods`)) load() }}><Upload size={12} /> Upload .tmod…</button>
        {(mods ?? []).some((m) => !m.local) && <button className={`btn ${outdated.length ? 'primary' : ''}`} onClick={updateAll}><ArrowUpCircle size={12} /> {outdated.length ? `Update (${outdated.length})` : 'Update All'}</button>}
        <button className="btn primary" onClick={onBrowse}><Download size={12} /> Get More</button>
      </div>
      {bad.length > 0 && <div className="card small" style={{ marginBottom: 14, borderLeft: '3px solid var(--red)' }}><b style={{ color: 'var(--red)' }}>{bad.length} mod{bad.length > 1 ? 's are' : ' is'} not made for tModLoader {TML_TAG}</b><div className="muted">{bad.map((m) => m.details?.title ?? m.name).join(', ')}</div></div>}
      <div className="group-box">
        {mods === null ? <div className="group-row"><Spinner size={14} /></div> : mods.length === 0 ? (
          <div className="empty" style={{ padding: 20 }}><Package size={34} strokeWidth={1.3} /><h3>No mods yet</h3><button className="btn primary" onClick={onBrowse}>Browse the Steam Workshop</button></div>
        ) : mods.map((m) => (
          <div key={m.id + m.name} className="group-row" style={{ opacity: m.enabled ? 1 : 0.55 }}>
            <div className="row" style={{ minWidth: 0, gap: 10 }}>
              {m.details?.preview ? <img src={m.details.preview} className="mc-addon-icon" alt="" /> : <div className="mc-addon-icon"><Package size={16} /></div>}
              <div style={{ minWidth: 0 }}>
                <div className="row" style={{ gap: 6 }}>
                  <b>{m.details?.title ?? m.name}</b>
                  {!m.enabled && <span className="badge">Disabled</span>}
                  {m.local && <span className="badge">Local file</span>}
                  {m.details && m.details.updated > m.mtime + 60000 && <span className="badge" style={{ color: 'var(--green)' }}>Update available</span>}
                  {m.enabled && <CompatBadge c={m.compat} label={`tML ${TML_TAG}`} />}
                </div>
                <div className="small muted">{m.name}{m.details ? ` · ${formatBytes(m.details.size, true)} · updated ${new Date(m.details.updated).toLocaleDateString()}` : ''}</div>
                {m.enabled && m.compat?.status === 'incompatible' && <div className="small" style={{ color: 'var(--red)' }}>{m.compat.reason}</div>}
              </div>
            </div>
            <div className="row">
              <button className="tb-btn" title="Edit configuration" onClick={() => setConfig(m)}><Settings2 size={14} /></button>
              {!m.local && <button className="tb-btn" title="Open in Steam Workshop" onClick={() => api.openExternal(`https://steamcommunity.com/sharedfiles/filedetails/?id=${m.id}`)}><ExternalLink size={13} /></button>}
              <button className="tb-btn" title={m.enabled ? 'Disable' : 'Enable'} onClick={() => toggle(m)}><Power size={14} /></button>
              <button className="tb-btn" title="Remove" onClick={() => remove(m)}><Trash2 size={14} /></button>
            </div>
          </div>
        ))}
      </div>
      {config && <ConfigFiles folder="data/ModConfigs" match={config.name} title={config.details?.title ?? config.name} onClose={() => setConfig(null)} />}
    </div>
  )
}

function BrowseMods() {
  const { srv, task } = useTrCtx()
  const { record } = useContentRegistry()
  const enabled = useEnabled()
  const [q, setQ] = useState('')
  const [dq, setDq] = useState('')
  const [hits, setHits] = useState<WorkshopItem[] | null>(null)
  const [err, setErr] = useState('')
  const [arch, setArch] = useState('')
  const [onlyCompat, setOnlyCompat] = useState(true)

  useEffect(() => { run(srv.hostId, 'uname -m').then((r) => setArch(r.stdout.trim())) }, [srv.hostId])
  useEffect(() => { const t = setTimeout(() => setDq(q), 450); return () => clearTimeout(t) }, [q])
  useEffect(() => {
    setHits(null)
    setErr('')
    searchWorkshop(dq).then(setHits).catch((e) => { setErr(e.message); setHits([]) })
  }, [dq])

  const canInstall = /x86_64|amd64/.test(arch)
  const install = async (m: WorkshopItem) => {
    const c = modCompat(m.tags)
    if (c.status === 'incompatible' && !(await confirm(`${m.title} is not made for tModLoader ${TML_TAG}`, `${c.reason} Install anyway?`, 'Install Anyway'))) return
    const r = await task(`Installing ${m.title}`, workshopInstallScript(srv.dir, [m.id]))
    if (r.code !== 0) return
    const n = await run(srv.hostId, `find ${shq(`${srv.dir}/steamapps/workshop/content/${TML_APP}/${m.id}`)} -name '*.tmod' | sort | tail -1`)
    const name = n.stdout.trim().split('/').pop()?.replace(/\.tmod$/, '')
    if (name) await enabled.write([...(await enabled.read()), name])
    await record(m.id, { source: 'workshop', id: m.id, title: m.title })
    toast({ title: `${m.title} installed and enabled`, body: 'If the mod needs other mods (see its Workshop page), install them too. Restart the server to load it.', kind: 'success', action: { label: 'Workshop page', run: () => api.openExternal(`https://steamcommunity.com/sharedfiles/filedetails/?id=${m.id}`) } })
  }

  const shown = (hits ?? []).filter((m) => !onlyCompat || modCompat(m.tags).status !== 'incompatible')
  return (
    <>
      <div className="row" style={{ padding: '8px 16px', borderBottom: '1px solid var(--border)' }}>
        <div className="search grow"><Search size={13} /><input placeholder="Search tModLoader mods" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <label className="row small"><input type="checkbox" checked={onlyCompat} onChange={(e) => setOnlyCompat(e.target.checked)} /> tModLoader {TML_TAG} only</label>
      </div>
      <div className="grow scroll pad">
        {arch && !canInstall && <div className="card small" style={{ marginBottom: 10, color: 'var(--orange)' }}>This server is {arch}. Workshop downloads need SteamCMD, which only runs on x86_64. Download mods elsewhere and upload the .tmod files (Installed → Upload .tmod).</div>}
        {err && <div className="empty">{err}</div>}
        {hits === null && <div className="empty"><Spinner size={22} /></div>}
        <div className="mc-results">
          {shown.map((m) => {
            const c = modCompat(m.tags)
            return (
              <div key={m.id} className="mc-result">
                {m.preview ? <img src={m.preview} className="mc-addon-icon lg" alt="" /> : <div className="mc-addon-icon lg"><Package size={22} /></div>}
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="row" style={{ gap: 6 }}><b>{m.title}</b><CompatBadge c={c} label={`tML ${TML_TAG}`} /></div>
                  <div className="small muted mc-desc">{m.description}</div>
                  <div className="small muted row" style={{ gap: 10, marginTop: 3 }}>
                    <span>{m.subscriptions.toLocaleString()} subscribers</span><span>{formatBytes(m.size, true)}</span><span>Updated {new Date(m.updated).toLocaleDateString()}</span>
                    {m.tags.filter((t) => !/^1\.\d/.test(t)).slice(0, 3).map((t) => <span key={t} className="badge" style={{ fontSize: 9 }}>{t}</span>)}
                  </div>
                </div>
                <div className="col" style={{ gap: 4 }}>
                  <button className="btn primary" disabled={!canInstall} onClick={() => install(m)}><Download size={11} /> Install</button>
                  <button className="btn" onClick={() => api.openExternal(`https://steamcommunity.com/sharedfiles/filedetails/?id=${m.id}`)}>Workshop</button>
                </div>
              </div>
            )
          })}
        </div>
        {hits && shown.length === 0 && !err && <div className="empty">No mods found{onlyCompat ? ` for tModLoader ${TML_TAG}` : ''}.</div>}
      </div>
    </>
  )
}
