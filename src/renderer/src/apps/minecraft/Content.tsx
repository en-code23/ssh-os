import { useEffect, useMemo, useState } from 'react'
import { Download, ExternalLink, Package, RefreshCw, Search, Trash2, ArrowUpCircle, Power, X, Settings2 } from 'lucide-react'
import { launch } from '../launch'
import { api, shq } from '../../lib/api'
import { confirm, toast } from '../../lib/store'
import {
  ContentHit, ContentKind, ContentSource, ContentVersion, fmtNum, listContentVersions, modrinthProject, resolveExternal, searchContent, SOFTWARE,
} from '../../lib/mc/apis'
import { fetchCmd, MC_DIR, run, safeFileName } from '../../lib/mc/server'
import { parseProps, serializeProps } from '../../lib/mc/properties'
import { formatBytes } from '../../lib/files'
import { checkApiVersion, checkDeclared, checkTested, inRange, type Compat } from '../../lib/mc/compat'
import { openInEditor } from '../../lib/actions'
import { Segmented, Spinner, Switch } from '../../components/ui'
import { Help, useCtx } from './common'

interface Installed {
  file: string
  dir: string
  kind: 'plugin' | 'mod' | 'datapack'
  size: number
  enabled: boolean
  name?: string
  version?: string
  description?: string
  sha1?: string
  // enriched from Modrinth
  mrTitle?: string
  mrIcon?: string
  mrProject?: string
  update?: { version: string; url: string; fileName: string; sha1: string; versionId: string }
  'api-version'?: string
  mcRange?: string | string[]
  modid?: string
  mrGameVersions?: string[]
  mrLoaders?: string[]
  compat?: Compat
}

const LIST_PY = (level: string) => `python3 - <<'EOF'
import os, zipfile, json, re, hashlib
out = []
for d, kind in [("plugins", "plugin"), ("mods", "mod"), (${JSON.stringify(level)} + "/datapacks", "datapack")]:
    if not os.path.isdir(d):
        continue
    for f in sorted(os.listdir(d), key=str.lower):
        p = os.path.join(d, f)
        ok = f.endswith((".jar", ".jar.disabled")) or (kind == "datapack" and (f.endswith((".zip", ".zip.disabled")) or os.path.isdir(p)))
        if not ok:
            continue
        e = {"file": f, "dir": d, "kind": kind, "size": os.path.getsize(p) if os.path.isfile(p) else 0, "enabled": not f.endswith(".disabled")}
        try:
            if os.path.isfile(p):
                z = zipfile.ZipFile(p)
                names = z.namelist()
                for meta in ("paper-plugin.yml", "plugin.yml"):
                    if meta in names:
                        t = z.read(meta).decode("utf8", "ignore")
                        for k in ("name", "version", "description", "api-version"):
                            m = re.search(r"^" + k + r":\\s*['\\"]?(.*?)['\\"]?\\s*$", t, re.M)
                            if m: e[k] = m.group(1)
                        break
                if "fabric.mod.json" in names:
                    j = json.loads(z.read("fabric.mod.json").decode("utf8", "ignore"), strict=False)
                    e.update(name=j.get("name"), version=j.get("version"), description=j.get("description"), modid=j.get("id"))
                    dep = (j.get("depends") or {}).get("minecraft")
                    if dep: e["mcRange"] = dep
                if "pack.mcmeta" in names and "description" not in e:
                    j = json.loads(z.read("pack.mcmeta").decode("utf8", "ignore"), strict=False)
                    desc = j.get("pack", {}).get("description")
                    e["description"] = desc if isinstance(desc, str) else ""
                e["sha1"] = hashlib.sha1(open(p, "rb").read()).hexdigest()
        except Exception as ex:
            e["error"] = str(ex)
        out.append(e)
print(json.dumps(out))
EOF`

function destFor(kind: ContentKind, level: string) {
  return kind === 'plugin' ? 'plugins' : kind === 'mod' ? 'mods' : kind === 'datapack' ? `${level}/datapacks` : ''
}

export function ContentTab() {
  const { srv } = useCtx()
  const [view, setView] = useState<'installed' | 'browse'>('installed')
  const sw = SOFTWARE[srv.config.software]
  return (
    <>
      <div className="row" style={{ padding: '8px 16px', borderBottom: '1px solid var(--border)', justifyContent: 'center' }}>
        <Segmented value={view} onChange={setView} options={[{ value: 'installed', label: 'Installed' }, { value: 'browse', label: 'Browse & Install' }]} />
        <Help
          title="Add-ons"
          text={`${sw.name} runs ${sw.content === 'none' ? 'no plugins or mods, only data packs' : sw.content}. Data packs work on every server; resource packs are offered to players when they join. See Help → Plugins, mods, data packs and resource packs.`}
        />
      </div>
      {view === 'installed' ? <InstalledView onBrowse={() => setView('browse')} /> : <BrowseView />}
    </>
  )
}

// ---------------------------------------------------------------------------
function InstalledView({ onBrowse }: { onBrowse: () => void }) {
  const { srv, task, saveCfg } = useCtx()
  const [items, setItems] = useState<Installed[] | null>(null)
  const [rp, setRp] = useState<{ url: string; sha1: string; required: boolean } | null>(null)
  const [checking, setChecking] = useState(false)
  const [noPython, setNoPython] = useState(false)
  const [rpCompat, setRpCompat] = useState<Compat | null>(null)
  const [configFor, setConfigFor] = useState<Installed | null>(null)
  const mc = srv.config.mcVersion
  const sw = srv.config.software

  /** Is this add-on compatible with the server's Minecraft version and software? */
  const compatOf = (i: Installed): Compat => {
    const pluginServer = SOFTWARE[sw]?.content === 'plugins'
    if (i.kind === 'mod' && pluginServer) return { status: 'incompatible', reason: `${SOFTWARE[sw].name} doesn't load mods from mods/; this file is ignored.` }
    if (i.kind === 'plugin' && SOFTWARE[sw]?.content === 'mods') return { status: 'incompatible', reason: `${SOFTWARE[sw].name} doesn't load plugins from plugins/; this file is ignored.` }
    if (i.mrGameVersions?.length) return checkDeclared({ gameVersions: i.mrGameVersions, loaders: i.mrLoaders, kind: i.kind }, mc, sw)
    if (i.kind === 'plugin') return checkApiVersion(i['api-version'], mc)
    if (i.kind === 'mod' && i.mcRange) return inRange(mc, i.mcRange) ? { status: 'ok' } : { status: 'incompatible', reason: `Requires Minecraft ${[i.mcRange].flat().join(' or ')}; server runs ${mc}.` }
    return { status: 'unknown' }
  }
  const withCompat = (list: Installed[]) => list.map((i) => ({ ...i, compat: compatOf(i) }))

  const load = async () => {
    setItems(null)
    const r = await run(srv.hostId, `cd ${shq(srv.dir)} || exit 1
if command -v python3 >/dev/null; then
${LIST_PY(srv.levelName)}
else echo NOPY; fi`, 60000)
    const props = parseProps(await api.fs.readText(srv.hostId, `${srv.dir}/server.properties`).catch(() => '')).values
    setRp(props['resource-pack'] ? { url: props['resource-pack'], sha1: props['resource-pack-sha1'] ?? '', required: props['require-resource-pack'] === 'true' } : null)
    if (r.stdout.trim() === 'NOPY') {
      setNoPython(true)
      const l = await run(srv.hostId, `cd ${shq(srv.dir)} && for d in plugins mods ${shq(srv.levelName + '/datapacks')}; do [ -d "$d" ] && for f in "$d"/*; do [ -e "$f" ] && echo "$d|$(basename "$f")|$(stat -c %s "$f" 2>/dev/null || echo 0)"; done; done`)
      setItems(
        l.stdout.split('\n').filter(Boolean).map((x) => {
          const [dir, file, size] = x.split('|')
          return { dir, file, size: +size, kind: dir === 'plugins' ? 'plugin' : dir === 'mods' ? 'mod' : 'datapack', enabled: !file.endsWith('.disabled') } as Installed
        }),
      )
      return
    }
    let list: Installed[] = []
    try { list = JSON.parse(r.stdout.trim().split('\n').pop() || '[]') } catch { list = [] }
    list = withCompat(list)
    setItems(list)
    checkResourcePack(props['resource-pack-sha1'])
    // enrich with Modrinth metadata
    const hashes = list.map((i) => i.sha1).filter(Boolean) as string[]
    if (!hashes.length) return
    try {
      const vers = await api.httpJson<Record<string, any>>('https://api.modrinth.com/v2/version_files', { method: 'POST', body: { hashes, algorithm: 'sha1' } })
      const ids = [...new Set(Object.values(vers ?? {}).map((v: any) => v.project_id))]
      const projects = ids.length ? await api.httpJson<any[]>(`https://api.modrinth.com/v2/projects?ids=${encodeURIComponent(JSON.stringify(ids))}`) : []
      const byId = Object.fromEntries((projects ?? []).map((p) => [p.id, p]))
      list = withCompat(list.map((i) => {
        const v = i.sha1 ? vers?.[i.sha1] : undefined
        const p = v ? byId[v.project_id] : undefined
        return p ? { ...i, mrTitle: p.title, mrIcon: p.icon_url, mrProject: p.id, version: i.version ?? v.version_number, mrGameVersions: v.game_versions, mrLoaders: v.loaders } : i
      }))
      setItems(list)
      // look for updates right away so outdated and incompatible add-ons are flagged without a click
      checkUpdates(list, true)
    } catch { /* offline: fine */ }
  }

  const checkResourcePack = async (sha1?: string) => {
    setRpCompat(null)
    if (!sha1 || !/^[a-f0-9]{40}$/i.test(sha1)) return
    try {
      const v = await api.httpJson<any>(`https://api.modrinth.com/v2/version_file/${sha1}?algorithm=sha1`)
      if (v?.game_versions) setRpCompat(checkDeclared({ gameVersions: v.game_versions, kind: 'resourcepack' }, mc, sw))
    } catch { /* unknown pack */ }
  }
  useEffect(() => { load() }, [srv.dir]) // eslint-disable-line

  const checkUpdates = async (current = items, quiet = false) => {
    if (!current) return
    setChecking(true)
    try {
      const hashes = current.filter((i) => i.sha1 && i.enabled).map((i) => i.sha1!)
      if (!hashes.length) return
      const loaders = [...SOFTWARE[srv.config.software].loaders, 'datapack']
      const upd = await api.httpJson<Record<string, any>>('https://api.modrinth.com/v2/version_files/update', {
        method: 'POST', body: { hashes, algorithm: 'sha1', loaders, game_versions: [srv.config.mcVersion] },
      })
      let n = 0
      setItems((list) => list!.map((i) => {
        const v = i.sha1 ? upd?.[i.sha1] : undefined
        if (!v) return i
        const f = v.files.find((x: any) => x.primary) ?? v.files[0]
        if (f.hashes.sha1 === i.sha1) return i
        n++
        return { ...i, update: { version: v.version_number, url: f.url, fileName: f.filename, sha1: f.hashes.sha1, versionId: v.id } }
      }))
      if (!quiet) toast({ title: n ? `${n} update${n > 1 ? 's' : ''} available` : 'Everything is up to date', body: 'Checked against Modrinth. Hangar/Spigot installs are checked by the Updates tab.', kind: n ? 'info' : 'success' })
    } catch (e: any) {
      if (!quiet) toast({ title: 'Update check failed', body: e.message, kind: 'error' })
    } finally {
      setChecking(false)
    }
  }

  const applyUpdate = async (list: Installed[]) => {
    for (const i of list) i.update!.fileName = safeFileName(i.update!.fileName)
    const script = list
      .map((i) => `cd ${shq(srv.dir + '/' + i.dir)} && echo ${shq(`Updating ${i.file} → ${i.update!.fileName}`)} && ${fetchCmd(i.update!.url, i.update!.fileName + '.part')} && mv -f ${shq(i.update!.fileName + '.part')} ${shq(i.update!.fileName)} && { [ ${shq(i.file)} = ${shq(i.update!.fileName)} ] || { mkdir -p ${shq(srv.dir + '/' + MC_DIR + '/old-content')} && mv -f ${shq(i.file)} ${shq(srv.dir + '/' + MC_DIR + '/old-content/')}; }; }`)
      .join(' && ')
    const r = await task(`Updating ${list.length} item${list.length > 1 ? 's' : ''}`, script + ' && echo "Restart the server to load the new versions."')
    if (r.code === 0 && srv.managed) {
      const content = { ...srv.config.content }
      for (const i of list) {
        const rec = content[i.file]
        if (rec) { delete content[i.file]; content[i.update!.fileName] = { ...rec, versionId: i.update!.versionId } }
      }
      await saveCfg({ content })
    }
    load()
  }

  const toggle = async (i: Installed) => {
    const to = i.enabled ? i.file + '.disabled' : i.file.replace(/\.disabled$/, '')
    await api.fs.rename(srv.hostId, `${srv.dir}/${i.dir}/${i.file}`, `${srv.dir}/${i.dir}/${to}`)
    toast({ title: `${i.enabled ? 'Disabled' : 'Enabled'} ${i.name ?? i.file}`, body: 'Restart the server to apply.' })
    load()
  }

  const remove = async (i: Installed) => {
    if (!(await confirm(`Remove ${i.mrTitle ?? i.name ?? i.file}?`, `The file is deleted from ${i.dir}/. Its configuration folder (if any) is kept.`, 'Remove', true))) return
    await api.fs.remove(srv.hostId, [{ path: `${srv.dir}/${i.dir}/${i.file}`, isDir: !i.file.includes('.') }])
    if (srv.managed && srv.config.content[i.file]) {
      const content = { ...srv.config.content }
      delete content[i.file]
      await saveCfg({ content })
    }
    load()
  }

  const removeRp = async () => {
    const path = `${srv.dir}/server.properties`
    const t = await api.fs.readText(srv.hostId, path)
    await api.fs.writeText(srv.hostId, path, serializeProps(t, { 'resource-pack': '', 'resource-pack-sha1': '', 'require-resource-pack': 'false' }))
    toast({ title: 'Resource pack removed', body: 'Restart the server to apply.' })
    load()
  }

  const updates = (items ?? []).filter((i) => i.update)
  const incompatible = (items ?? []).filter((i) => i.enabled && i.compat?.status === 'incompatible')
  const groups: [string, Installed['kind']][] = [['Plugins', 'plugin'], ['Mods', 'mod'], ['Data packs', 'datapack']]

  return (
    <div className="grow scroll pad" style={{ maxWidth: 900, width: '100%', margin: '0 auto' }}>
      <div className="row" style={{ marginBottom: 12 }}>
        <div className="grow small muted">{items ? `${items.length} installed` : 'Loading…'}{noPython ? ' · install python3 on the server for names and update checks' : ''}</div>
        <button className="btn" onClick={load}><RefreshCw size={12} /></button>
        <button className="btn" disabled={!items || checking || noPython} onClick={() => checkUpdates()}>{checking ? <Spinner size={12} /> : <ArrowUpCircle size={12} />} Check for Updates</button>
        {updates.length > 0 && <button className="btn primary" onClick={() => applyUpdate(updates)}>Update All ({updates.length})</button>}
        <button className="btn primary" onClick={onBrowse}><Download size={12} /> Get More</button>
      </div>
      {incompatible.length > 0 && (
        <div className="card small" style={{ marginBottom: 14, borderLeft: '3px solid var(--red)', lineHeight: 1.5 }}>
          <b style={{ color: 'var(--red)' }}>{incompatible.length} add-on{incompatible.length > 1 ? 's are' : ' is'} not compatible with Minecraft {mc}</b>
          <div className="muted">{incompatible.map((i) => i.mrTitle ?? i.name ?? i.file).join(', ')}.{' '}
            {incompatible.some((i) => i.update) ? 'Updates are available for some of them.' : 'Look for a newer version or disable them to avoid startup errors.'}</div>
        </div>
      )}
      {updates.length > 0 && (
        <div className="card small row" style={{ marginBottom: 14, borderLeft: '3px solid var(--green)' }}>
          <span className="grow"><b>{updates.length} update{updates.length > 1 ? 's' : ''} available</b> <span className="muted">· {updates.map((i) => i.mrTitle ?? i.name ?? i.file).join(', ')}</span></span>
          <button className="btn primary" onClick={() => applyUpdate(updates)}>Update All</button>
        </div>
      )}

      <div className="sb-section" style={{ paddingLeft: 2 }}>Resource pack</div>
      <div className="group-box" style={{ marginBottom: 16 }}>
        {rp ? (
          <div className="group-row">
            <div style={{ minWidth: 0 }}>
              <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} className="mono small">{rp.url}</div>
              <div className="small muted">{rp.required ? 'Required for players' : 'Optional for players'}{rp.sha1 ? ` · sha1 ${rp.sha1.slice(0, 10)}…` : ' · no checksum set'}</div>
              {rpCompat?.status === 'incompatible' && <div className="small" style={{ color: 'var(--red)' }}>Not made for Minecraft {mc}: {rpCompat.reason} Players may see missing or broken textures.</div>}
              {rpCompat?.status === 'ok' && <div className="small" style={{ color: 'var(--green)' }}>Made for Minecraft {mc}</div>}
            </div>
            <button className="btn" onClick={removeRp}><X size={12} /> Remove</button>
          </div>
        ) : (
          <div className="group-row"><span className="muted">No server resource pack. Browse → Resource Packs to add one.</span></div>
        )}
      </div>

      {items === null && <div className="empty"><Spinner size={22} /></div>}
      {items && groups.map(([label, kind]) => {
        const l = items.filter((i) => i.kind === kind)
        if (!l.length) return null
        return (
          <div key={kind}>
            <div className="sb-section" style={{ paddingLeft: 2 }}>{label} · {l.length}</div>
            <div className="group-box" style={{ marginBottom: 16 }}>
              {l.map((i) => (
                <div key={i.dir + i.file} className="group-row" style={{ opacity: i.enabled ? 1 : 0.55 }}>
                  <div className="row" style={{ minWidth: 0, gap: 10 }}>
                    {i.mrIcon ? <img src={i.mrIcon} className="mc-addon-icon" alt="" /> : <div className="mc-addon-icon"><Package size={16} /></div>}
                    <div style={{ minWidth: 0 }}>
                      <div className="row" style={{ gap: 6 }}>
                        <b>{i.mrTitle ?? i.name ?? i.file.replace(/\.(jar|zip)(\.disabled)?$/, '')}</b>
                        {i.version && <span className="badge">{i.version}</span>}
                        {!i.enabled && <span className="badge">Disabled</span>}
                        {srv.config.content[i.file] && <span className="badge">{srv.config.content[i.file].source}</span>}
                        {i.update && <span className="badge" style={{ color: 'var(--green)' }}>→ {i.update.version}</span>}
                        {i.enabled && i.compat?.status === 'incompatible' && <span className="badge" style={{ color: 'var(--red)' }} title={i.compat.reason}>Not compatible</span>}
                        {i.enabled && i.compat?.status === 'ok' && <span className="badge" style={{ color: 'var(--green)' }} title={`Works with Minecraft ${mc}`}>✓ {mc}</span>}
                      </div>
                      <div className="small muted" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 520 }}>
                        {i.description || i.file} · {formatBytes(i.size, true)}
                      </div>
                      {i.enabled && i.compat?.status === 'incompatible' && (
                        <div className="small" style={{ color: 'var(--red)' }}>{i.compat.reason}{i.update ? ' The available update supports this version.' : ''}</div>
                      )}
                      {i.enabled && i.compat?.status === 'unknown' && i.compat.reason && <div className="small" style={{ color: 'var(--orange)' }}>{i.compat.reason}</div>}
                    </div>
                  </div>
                  <div className="row">
                    {i.update && <button className="btn primary" onClick={() => applyUpdate([i])}>Update</button>}
                    {i.kind !== 'datapack' && <button className="tb-btn" title="Edit configuration" onClick={() => setConfigFor(i)}><Settings2 size={14} /></button>}
                    {i.mrProject && <button className="tb-btn" title="Open on Modrinth" onClick={() => api.openExternal(`https://modrinth.com/project/${i.mrProject}`)}><ExternalLink size={13} /></button>}
                    <button className="tb-btn" title={i.enabled ? 'Disable' : 'Enable'} onClick={() => toggle(i)}><Power size={14} /></button>
                    <button className="tb-btn" title="Remove" onClick={() => remove(i)}><Trash2 size={14} /></button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )
      })}
      {items && items.length === 0 && (
        <div className="empty" style={{ padding: 20 }}>
          <Package size={36} strokeWidth={1.3} />
          <h3>Nothing installed yet</h3>
          <button className="btn primary" onClick={onBrowse}>Browse Modrinth, Hangar & SpigotMC</button>
        </div>
      )}
      {configFor && <ConfigSheet item={configFor} onClose={() => setConfigFor(null)} />}
    </div>
  )
}

/** Lists an add-on's configuration files and opens them in the Code Editor. */
function ConfigSheet({ item, onClose }: { item: Installed; onClose: () => void }) {
  const { srv } = useCtx()
  const [files, setFiles] = useState<{ path: string; size: number }[] | null>(null)
  const title = item.mrTitle ?? item.name ?? item.file
  // plugins keep config in plugins/<plugin.yml name>/, Fabric mods in config/ (named after the mod id)
  const folder = item.kind === 'plugin' ? `plugins/${item.name ?? item.file.replace(/\.jar(\.disabled)?$/, '')}` : 'config'
  const filter = item.kind === 'mod' ? (item.modid ?? item.file.replace(/[-_.].*$/, '')).toLowerCase() : ''

  useEffect(() => {
    const exts = '\\.(ya?ml|json5?|toml|properties|conf|cfg|txt|ini|hocon|xml|lang|mcmeta|sk)$'
    run(srv.hostId, `cd ${shq(srv.dir)} && [ -d ${shq(folder)} ] && find ${shq(folder)} -maxdepth 4 -type f -size -2M 2>/dev/null | grep -iE '${exts}' | head -200 | while read -r f; do echo "$(stat -c %s "$f" 2>/dev/null || echo 0)|$f"; done; true`)
      .then((r) => {
        const all = r.stdout.split('\n').filter(Boolean).map((l) => { const i = l.indexOf('|'); return { size: +l.slice(0, i), path: l.slice(i + 1) } })
        setFiles(filter ? all.filter((f) => f.path.toLowerCase().includes(filter)) : all)
      })
      .catch(() => setFiles([]))
  }, [folder, filter]) // eslint-disable-line

  return (
    <div className="modal-backdrop" style={{ position: 'absolute', paddingTop: 30, zIndex: 40 }} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet" style={{ width: 620, maxHeight: '80%', display: 'flex', flexDirection: 'column' }}>
        <h3 style={{ marginBottom: 4 }}>{title} configuration</h3>
        <div className="small muted" style={{ marginBottom: 12 }}>
          Files in <span className="mono">{folder}/</span>{filter ? ` matching “${filter}”` : ''}. Changes usually need a restart (or the plugin’s own reload command).
        </div>
        <div className="grow scroll group-box" style={{ minHeight: 80 }}>
          {files === null ? <div className="group-row"><Spinner size={14} /></div> : files.length === 0 ? (
            <div className="group-row muted">No configuration files yet. Most plugins create them on their first start.</div>
          ) : files.map((f) => (
            <div key={f.path} className="group-row">
              <span className="mono small" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{f.path.slice(folder.length + 1) || f.path}</span>
              <span className="row">
                <span className="small muted">{formatBytes(f.size, true)}</span>
                <button className="btn" onClick={() => { openInEditor(srv.hostId, `${srv.dir}/${f.path}`); onClose() }}>Edit</button>
              </span>
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

// ---------------------------------------------------------------------------
function BrowseView() {
  const { srv, task, saveCfg } = useCtx()
  const sw = SOFTWARE[srv.config.software]
  const kinds: { value: ContentKind; label: string }[] = [
    ...(sw.content === 'plugins' ? [{ value: 'plugin' as const, label: 'Plugins' }] : sw.content === 'mods' ? [{ value: 'mod' as const, label: 'Mods' }] : []),
    { value: 'datapack', label: 'Data Packs' },
    { value: 'resourcepack', label: 'Resource Packs' },
  ]
  const [kind, setKind] = useState<ContentKind>(kinds[0].value)
  const [source, setSource] = useState<ContentSource>('modrinth')
  const [q, setQ] = useState('')
  const [debounced, setDebounced] = useState('')
  const [sort, setSort] = useState<'relevance' | 'downloads' | 'updated'>('downloads')
  const [compatible, setCompatible] = useState(true)
  const [hits, setHits] = useState<ContentHit[] | null>(null)
  const [total, setTotal] = useState(0)
  const [error, setError] = useState('')
  const [detail, setDetail] = useState<ContentHit | null>(null)
  const [installing, setInstalling] = useState<string | null>(null)

  const sources: ContentSource[] = kind === 'plugin' ? ['modrinth', 'hangar', 'spigot'] : ['modrinth']
  useEffect(() => { if (!sources.includes(source)) setSource('modrinth') }, [kind]) // eslint-disable-line
  useEffect(() => { const t = setTimeout(() => setDebounced(q), 350); return () => clearTimeout(t) }, [q])

  const query = (offset = 0) =>
    searchContent(source, debounced, kind, { loaders: sw.loaders, version: compatible && srv.config.mcVersion ? srv.config.mcVersion : undefined, sort: debounced ? sort : sort === 'relevance' ? 'downloads' : sort, offset })

  useEffect(() => {
    let cancel = false
    setHits(null)
    setError('')
    query()
      .then((r) => { if (!cancel) { setHits(r.hits); setTotal(r.total) } })
      .catch((e) => { if (!cancel) { setError(e.message); setHits([]) } })
    return () => { cancel = true }
  }, [debounced, kind, source, sort, compatible]) // eslint-disable-line

  const more = async () => {
    const r = await query(hits?.length ?? 0)
    setHits((h) => [...(h ?? []), ...r.hits])
  }

  /** install one version; returns true on success */
  const installVersion = async (hit: ContentHit, v: ContentVersion, withDeps = true): Promise<boolean> => {
    let url = v.url
    let fileName = v.fileName ?? `${hit.slug}.jar`
    if (!url && v.externalUrl) {
      const ext = await resolveExternal(v.externalUrl).catch(() => null)
      if (!ext) {
        toast({ title: `${hit.title} is hosted externally`, body: 'Opening its download page. Download the .jar and drag it into the plugins folder in Finder.', action: { label: 'Open', run: () => api.openExternal(v.externalUrl!) } })
        api.openExternal(v.externalUrl)
        return false
      }
      url = ext.url
      fileName = ext.fileName
    }
    if (!url) {
      toast({ title: 'No downloadable file for this version', kind: 'error' })
      return false
    }
    fileName = safeFileName(fileName, `${hit.slug.replace(/[^\w-]/g, '')}.jar`)

    if (hit.kind === 'resourcepack') {
      const path = `${srv.dir}/server.properties`
      const t = await api.fs.readText(srv.hostId, path)
      await api.fs.writeText(srv.hostId, path, serializeProps(t, { 'resource-pack': url, 'resource-pack-sha1': v.sha1 ?? '' }))
      toast({ title: `Resource pack set: ${hit.title}`, body: 'Players are offered it when they join (after a restart). Make it required under Settings → Resource Pack.', kind: 'success' })
      return true
    }

    const dest = destFor(hit.kind, srv.levelName)
    const sha1 = /^[a-f0-9]{40}$/i.test(v.sha1 ?? '') ? v.sha1 : undefined
    const verify = sha1 ? ` && if command -v sha1sum >/dev/null; then echo ${shq(`${sha1}  ${fileName}.part`)} | sha1sum -c - >/dev/null || { echo "Checksum mismatch"; rm -f ${shq(fileName + '.part')}; exit 4; }; fi` : ''
    const r = await task(
      `Installing ${hit.title} ${v.version}`,
      `mkdir -p ${shq(srv.dir + '/' + dest)} && cd ${shq(srv.dir + '/' + dest)} && echo ${shq(`Downloading ${fileName}…`)} && ${fetchCmd(url, fileName + '.part')}${verify} && mv -f ${shq(fileName + '.part')} ${shq(fileName)} && echo ${shq(`Installed into ${dest}/${fileName}`)} && echo ${shq(hit.kind === 'datapack' ? 'Run /reload in the console or restart to enable it.' : 'Restart the server to load it.')}`,
      { quiet: !withDeps },
    )
    if (r.code !== 0) return false
    if (srv.managed) {
      await saveCfg({ content: { ...srv.config.content, [fileName]: { source: hit.source, projectId: hit.id, versionId: v.id, title: hit.title, kind: hit.kind } } })
    }
    // required dependencies (Modrinth)
    const deps = (v.dependencies ?? []).filter((d) => d.type === 'required')
    if (withDeps && deps.length) {
      const projs = await Promise.all(deps.map((d) => modrinthProject(d.projectId).catch(() => null)))
      const names = projs.filter(Boolean).map((p: any) => p.title)
      if (names.length && (await confirm(`${hit.title} requires: ${names.join(', ')}`, 'Install the required dependencies too?', 'Install'))) {
        for (const p of projs.filter(Boolean) as any[]) {
          const h: ContentHit = { source: 'modrinth', id: p.id, slug: p.slug, title: p.title, author: '', description: '', downloads: 0, kind: hit.kind, url: '' }
          const vs = await listContentVersions(h, sw.loaders, srv.config.mcVersion)
          if (vs[0]) await installVersion(h, vs.find((x) => x.channel === 'release') ?? vs[0], false)
        }
      }
    }
    return true
  }

  const quickInstall = async (hit: ContentHit) => {
    setInstalling(hit.id)
    try {
      const vs = await listContentVersions(hit, sw.loaders, compatible ? srv.config.mcVersion : undefined)
      const v = vs.find((x) => !x.channel || x.channel === 'release' || x.channel === 'Release') ?? vs[0]
      if (!v) {
        toast({ title: `No version of ${hit.title} for ${sw.name} ${srv.config.mcVersion}`, body: 'Open “Versions” to pick one manually.', kind: 'error' })
        return
      }
      await installVersion(hit, v)
    } catch (e: any) {
      toast({ title: 'Install failed', body: e.message, kind: 'error' })
    } finally {
      setInstalling(null)
    }
  }

  return (
    <>
      <div className="row" style={{ padding: '8px 16px', borderBottom: '1px solid var(--border)', flexWrap: 'wrap' }}>
        <Segmented value={kind} onChange={setKind} options={kinds} />
        {sources.length > 1 && (
          <Segmented value={source} onChange={setSource} options={[{ value: 'modrinth', label: 'Modrinth' }, { value: 'hangar', label: 'Hangar' }, { value: 'spigot', label: 'SpigotMC' }]} />
        )}
        <div className="search grow" style={{ minWidth: 160 }}>
          <Search size={13} />
          <input placeholder={`Search ${source === 'modrinth' ? 'Modrinth' : source === 'hangar' ? 'Hangar' : 'SpigotMC'}`} value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <select className="select" style={{ width: 130 }} value={sort} onChange={(e) => setSort(e.target.value as any)}>
          <option value="relevance">Relevance</option>
          <option value="downloads">Downloads</option>
          <option value="updated">Recently updated</option>
        </select>
        {source !== 'spigot' && (
          <label className="row small" title={`Only show add-ons that support ${srv.config.mcVersion}`}>
            <Switch on={compatible} onChange={setCompatible} /> {srv.config.mcVersion || 'my version'} only
          </label>
        )}
      </div>
      <div className="grow scroll pad">
        {source === 'spigot' && <div className="card small" style={{ marginBottom: 10 }}>SpigotMC results are not filtered by version. Check “Tested versions” before installing. Some resources are hosted externally and open in your browser.</div>}
        {error && <div className="empty">{error}</div>}
        {hits === null && <div className="empty"><Spinner size={22} /></div>}
        <div className="mc-results">
          {hits?.map((h) => (
            <div key={h.source + h.id} className="mc-result">
              {h.icon ? <img src={h.icon} className="mc-addon-icon lg" alt="" /> : <div className="mc-addon-icon lg"><Package size={22} /></div>}
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="row" style={{ gap: 6 }}>
                  <b style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{h.title}</b>
                  {h.author && <span className="small muted">by {h.author}</span>}
                  {h.external && <span className="badge">External</span>}
                  {(() => {
                    const c = h.tested ? checkTested(h.gameVersions, srv.config.mcVersion) : checkDeclared({ gameVersions: h.gameVersions, kind: h.kind }, srv.config.mcVersion, srv.config.software)
                    if (c.status === 'incompatible') return <span className="badge" style={{ color: 'var(--red)' }} title={c.reason}>Not for {srv.config.mcVersion}</span>
                    if (c.status === 'ok') return <span className="badge" style={{ color: 'var(--green)' }}>✓ {srv.config.mcVersion}</span>
                    return null
                  })()}
                </div>
                <div className="small muted mc-desc">{h.description}</div>
                <div className="small muted row" style={{ gap: 10, marginTop: 3 }}>
                  <span><Download size={10} /> {fmtNum(h.downloads)}</span>
                  {h.updated && <span>Updated {new Date(h.updated).toLocaleDateString()}</span>}
                  {h.categories?.slice(0, 4).map((c) => <span key={c} className="badge" style={{ fontSize: 9 }}>{c}</span>)}
                </div>
              </div>
              <div className="col" style={{ gap: 4, alignItems: 'stretch' }}>
                <button className="btn primary" disabled={installing === h.id} onClick={() => quickInstall(h)}>
                  {installing === h.id ? <Spinner size={11} /> : <Download size={11} />} {kind === 'resourcepack' ? 'Use' : 'Install'}
                </button>
                <button className="btn" onClick={() => setDetail(h)}>Versions</button>
              </div>
            </div>
          ))}
        </div>
        {hits && hits.length > 0 && hits.length < total && (
          <div style={{ textAlign: 'center', padding: 12 }}><button className="btn" onClick={more}>Load more</button></div>
        )}
        {hits && hits.length === 0 && !error && <div className="empty">No results{compatible ? ` for ${srv.config.mcVersion}. Try turning off the version filter.` : ''}</div>}
      </div>
      {detail && <VersionsSheet hit={detail} loaders={sw.loaders} mcVersion={srv.config.mcVersion} onClose={() => setDetail(null)} onInstall={async (v) => { if (await installVersion(detail, v)) setDetail(null) }} />}
    </>
  )
}

function VersionsSheet({ hit, loaders, mcVersion, onClose, onInstall }: { hit: ContentHit; loaders: string[]; mcVersion: string; onClose: () => void; onInstall: (v: ContentVersion) => void }) {
  const [all, setAll] = useState(false)
  const [vs, setVs] = useState<ContentVersion[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  useEffect(() => {
    setVs(null)
    listContentVersions(hit, loaders, all ? undefined : mcVersion).then(setVs).catch((e) => { toast({ title: 'Could not load versions', body: e.message, kind: 'error' }); setVs([]) })
  }, [hit, all]) // eslint-disable-line
  const compat = useMemo(() => new Set(vs?.filter((v) => v.gameVersions.includes(mcVersion)).map((v) => v.id)), [vs, mcVersion])
  return (
    <div className="modal-backdrop" style={{ position: 'absolute', paddingTop: 30, zIndex: 40 }} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet" style={{ width: 680, maxHeight: '80%', display: 'flex', flexDirection: 'column' }}>
        <div className="row" style={{ marginBottom: 10 }}>
          {hit.icon ? <img src={hit.icon} className="mc-addon-icon lg" alt="" /> : null}
          <div className="grow">
            <b style={{ fontSize: 15 }}>{hit.title}</b>
            <div className="small muted">{hit.description}</div>
          </div>
          <button className="btn" onClick={() => api.openExternal(hit.url)}><ExternalLink size={12} /> Website</button>
        </div>
        <label className="row small" style={{ marginBottom: 8 }}><Switch on={all} onChange={setAll} /> Show versions for all Minecraft versions</label>
        <div className="grow scroll" style={{ minHeight: 120 }}>
          {vs === null ? <Spinner size={18} /> : vs.length === 0 ? <div className="muted">No versions found.</div> : (
            <table className="table">
              <thead><tr><th>Version</th><th>Minecraft</th><th>Type</th><th>Released</th><th /></tr></thead>
              <tbody>
                {vs.slice(0, 60).map((v) => (
                  <tr key={v.id}>
                    <td><b>{v.version}</b>{v.name !== v.version ? <span className="muted"> · {v.name}</span> : null}</td>
                    <td className="small" style={{ maxWidth: 180 }} title={v.gameVersions.join(', ')}>
                      {compat.has(v.id) ? <span style={{ color: 'var(--green)' }}>✓ {mcVersion}</span> : v.gameVersions.slice(-3).join(', ')}
                    </td>
                    <td className="small">{v.channel ?? '—'}</td>
                    <td className="small">{new Date(v.date).toLocaleDateString()}</td>
                    <td>
                      <button className="btn" disabled={busy !== null} onClick={async () => { setBusy(v.id); await onInstall(v); setBusy(null) }}>
                        {busy === v.id ? <Spinner size={10} /> : null} {v.url ? 'Install' : v.externalUrl ? 'Get' : '—'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div className="sheet-actions"><button className="btn" onClick={onClose}>Close</button></div>
      </div>
    </div>
  )
}
