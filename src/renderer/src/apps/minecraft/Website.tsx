import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Copy, ExternalLink, Globe, Lock, Map as MapIcon, Minus, Plus, RefreshCw, Shield, Maximize2, Dices } from 'lucide-react'
import { api } from '../../lib/api'
import { toast } from '../../lib/store'
import { Spinner, Switch } from '../../components/ui'
import { launch } from '../launch'
import { chunkbaseUrl, openPortsCommand, configureWebsite, defaultWeb, portFree, randomSeed, websiteStatus, webctl, type MapResult, type WebSettings, type WebStatus } from '../../lib/web/site'
import { Row, Section, useCtx } from './common'

const copy = (t: string, what = 'Copied') => { navigator.clipboard.writeText(t); toast({ title: what, kind: 'success' }) }

// ---------------------------------------------------------------------------
// World map viewer (Minecraft + Terraria)

export function WorldMapSheet({ title, game, result, error, onClose, actions, note }: {
  title: string
  game: 'minecraft' | 'terraria'
  result: MapResult | null
  error?: string
  onClose: () => void
  actions?: ReactNode
  note?: ReactNode
}) {
  const box = useRef<HTMLDivElement>(null)
  const img = useRef<HTMLImageElement>(null)
  const [v, setV] = useState<{ s: number; x: number; y: number } | null>(null)
  const drag = useRef<[number, number] | null>(null)
  const w = result?.info ?? {}

  const fit = () => {
    const b = box.current?.getBoundingClientRect()
    const i = img.current
    if (!b || !i || !i.naturalWidth) return
    const s = Math.min(b.width / i.naturalWidth, b.height / i.naturalHeight)
    setV({ s, x: (b.width - i.naturalWidth * s) / 2, y: (b.height - i.naturalHeight * s) / 2 })
  }
  const zoom = (f: number, cx?: number, cy?: number) => setV((o) => {
    if (!o) return o
    const b = box.current!.getBoundingClientRect()
    const px = cx ?? b.width / 2, py = cy ?? b.height / 2
    const s = Math.max(0.02, Math.min(32, o.s * f))
    const k = s / o.s
    return { s, x: px - (px - o.x) * k, y: py - (py - o.y) * k }
  })

  // markers in image pixels
  const scale = game === 'terraria' ? (w.mapScale || 1) : 1
  const marks: { x: number; y: number; color: string; label: string }[] = []
  if (game === 'terraria') {
    if (w.spawn) marks.push({ x: w.spawn[0] / scale, y: w.spawn[1] / scale, color: '#4f8cff', label: 'Spawn' })
    if (w.dungeon) marks.push({ x: w.dungeon[0] / scale, y: w.dungeon[1] / scale, color: '#c084fc', label: 'Dungeon' })
    for (const n of w.npcs ?? []) marks.push({ x: n.x / scale, y: n.y / scale, color: '#34c759', label: n.name ? `${n.name} (${n.kind})` : n.kind })
  } else if (w.map && w.spawn) marks.push({ x: w.spawn[0] - w.map.x, y: w.spawn[2] - w.map.z, color: '#4f8cff', label: 'Spawn' })

  const rows: [string, ReactNode][] = []
  if (w.name !== undefined) {
    rows.push(['Name', w.name || '—'])
    if (w.seed) rows.push(['Seed', <span key="s" className="row" style={{ gap: 6 }}><span className="mono">{w.seed}</span><button className="tb-btn" title="Copy seed" onClick={() => copy(String(w.seed), 'Seed copied')}><Copy size={12} /></button></span>])
    if (game === 'terraria') {
      rows.push(['Size', `${w.sizeName} (${w.width} × ${w.height})`], ['Difficulty', w.difficulty], ['Evil', w.evil])
      if (w.special?.length) rows.push(['Secret seeds', w.special.join(', ')])
      rows.push(['Progress', w.hardmode ? 'Hardmode' : 'Pre-Hardmode'])
    } else {
      rows.push(['Version', w.version || '—'], ['Game mode', w.gameMode], ['Difficulty', `${w.difficulty}${w.hardcore ? ' (Hardcore)' : ''}`], ['Spawn', (w.spawn ?? []).join(', ')])
      if (w.map) rows.push(['Map area', `${w.map.width} × ${w.map.height} blocks around spawn`])
    }
  }
  const bosses: [string, boolean][] = Object.entries(w.bosses ?? {}) as [string, boolean][]

  return (
    <div className="modal-backdrop" style={{ position: 'absolute', paddingTop: 20, zIndex: 45 }} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet" style={{ width: 'min(1100px, calc(100% - 40px))', height: 'calc(100% - 40px)', display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div className="row">
          <MapIcon size={16} />
          <b className="grow">{title}</b>
          {result?.png && (
            <>
              <button className="tb-btn" title="Zoom out" onClick={() => zoom(1 / 1.5)}><Minus size={14} /></button>
              <button className="tb-btn" title="Zoom in" onClick={() => zoom(1.5)}><Plus size={14} /></button>
              <button className="tb-btn" title="Fit" onClick={fit}><Maximize2 size={13} /></button>
            </>
          )}
        </div>
        <div className="row grow" style={{ alignItems: 'stretch', gap: 12, minHeight: 0 }}>
          <div
            ref={box}
            className="grow"
            style={{ position: 'relative', overflow: 'hidden', background: '#0b0b0d', borderRadius: 10, border: '1px solid var(--border)', cursor: drag.current ? 'grabbing' : 'grab', minWidth: 0 }}
            onWheel={(e) => { const b = box.current!.getBoundingClientRect(); zoom(e.deltaY < 0 ? 1.2 : 1 / 1.2, e.clientX - b.left, e.clientY - b.top) }}
            onPointerDown={(e) => { drag.current = [e.clientX, e.clientY]; (e.target as HTMLElement).setPointerCapture?.(e.pointerId) }}
            onPointerMove={(e) => { if (!drag.current) return; const [x0, y0] = drag.current; drag.current = [e.clientX, e.clientY]; setV((o) => (o ? { ...o, x: o.x + e.clientX - x0, y: o.y + e.clientY - y0 } : o)) }}
            onPointerUp={() => { drag.current = null }}
          >
            {!result && !error && <div className="empty"><Spinner size={22} /><div className="small muted" style={{ marginTop: 10 }}>{note ?? 'Reading the world…'}</div></div>}
            {error && <div className="empty"><div style={{ color: 'var(--red)', whiteSpace: 'pre-wrap', maxWidth: 520 }} className="small">{error}</div></div>}
            {result && !result.png && <div className="empty small muted">No explored area yet. The map fills in as players explore.</div>}
            {result?.png && (
              <>
                <img
                  ref={img}
                  src={result.png}
                  alt=""
                  draggable={false}
                  onLoad={fit}
                  style={{ position: 'absolute', left: 0, top: 0, transformOrigin: '0 0', transform: v ? `translate(${v.x}px, ${v.y}px) scale(${v.s})` : undefined, imageRendering: v && v.s >= 1 ? 'pixelated' : 'auto', visibility: v ? 'visible' : 'hidden', maxWidth: 'none' }}
                />
                {v && marks.map((m, i) => (
                  <div key={i} title={m.label} style={{ position: 'absolute', left: v.x + m.x * v.s - 5, top: v.y + m.y * v.s - 5, width: 10, height: 10, borderRadius: 5, background: m.color, border: '1.5px solid #000', pointerEvents: 'auto' }}>
                    {(v.s > 0.5 || marks.length < 4) && <span style={{ position: 'absolute', left: 13, top: -4, whiteSpace: 'nowrap', fontSize: 11, color: '#fff', textShadow: '0 1px 2px #000' }}>{m.label}</span>}
                  </div>
                ))}
              </>
            )}
          </div>
          {rows.length > 0 && (
            <div className="scroll" style={{ width: 270, flexShrink: 0 }}>
              <div className="group-box">
                {rows.map(([k, val]) => (
                  <div key={k} className="group-row" style={{ minHeight: 34 }}><span className="small muted">{k}</span><span className="small" style={{ textAlign: 'right' }}>{val}</span></div>
                ))}
              </div>
              {game === 'minecraft' && w.seed && (
                <button className="btn" style={{ width: '100%', marginTop: 10 }} onClick={() => api.openExternal(chunkbaseUrl(String(w.seed), w.spawn?.[0], w.spawn?.[2]))}>
                  <ExternalLink size={12} /> Explore seed (biomes, structures)
                </button>
              )}
              {bosses.length > 0 && (
                <div style={{ marginTop: 12 }}>
                  <div className="small muted" style={{ margin: '0 2px 6px' }}>Bosses defeated</div>
                  <div className="row" style={{ flexWrap: 'wrap', gap: 4 }}>
                    {bosses.map(([n, d]) => <span key={n} className="badge" style={{ color: d ? 'var(--green)' : 'var(--text-3)' }}>{d ? '✓ ' : ''}{n}</span>)}
                  </div>
                </div>
              )}
              {(w.npcs?.length ?? 0) > 0 && (
                <div style={{ marginTop: 12 }}>
                  <div className="small muted" style={{ margin: '0 2px 6px' }}>Town NPCs</div>
                  <div className="row" style={{ flexWrap: 'wrap', gap: 4 }}>
                    {w.npcs.map((n: any, i: number) => <span key={i} className="badge">{n.name ? `${n.name} · ` : ''}{n.kind}</span>)}
                  </div>
                </div>
              )}
              <div className="small muted" style={{ marginTop: 12, lineHeight: 1.5 }}>
                <span style={{ color: '#4f8cff' }}>●</span> Spawn{game === 'terraria' && <> · <span style={{ color: '#c084fc' }}>●</span> Dungeon · <span style={{ color: '#34c759' }}>●</span> Town NPC</>}. Scroll to zoom, drag to move.
              </div>
            </div>
          )}
        </div>
        <div className="sheet-actions" style={{ marginTop: 0 }}>
          {actions}
          <button className="btn primary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Seed input with a random button (+ Minecraft: open in Chunkbase)

export function SeedInput({ game, value, onChange, width = 240, placeholder }: { game: 'minecraft' | 'terraria'; value: string; onChange: (v: string) => void; width?: number; placeholder?: string }) {
  return (
    <div className="row" style={{ gap: 6 }}>
      <input className="input mono" style={{ width }} placeholder={placeholder ?? 'Random'} value={value} onChange={(e) => onChange(e.target.value)} />
      <button className="btn" title="Random seed" onClick={() => onChange(randomSeed(game))}><Dices size={13} /></button>
      {game === 'minecraft' && (
        <button className="btn" title="Preview this seed on an interactive map (Chunkbase)" disabled={!value.trim()} onClick={() => api.openExternal(chunkbaseUrl(value.trim()))}><MapIcon size={12} /> Preview</button>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Website: wizard fields

export interface WebsiteForm { enabled: boolean; port: number; player: string; admin: string }

export function websiteFormValid(f: WebsiteForm) {
  return !f.enabled || (f.admin.length >= 6 && f.player.length >= 4 && f.admin !== f.player && f.port > 1023 && f.port < 65536)
}

export function WebsiteFields({ form, onChange, gamePort }: { form: WebsiteForm; onChange: (f: WebsiteForm) => void; gamePort: number }) {
  const set = (p: Partial<WebsiteForm>) => onChange({ ...form, ...p })
  return (
    <Section title="Server website" help="A private HTTPS page with the server status, who is online and a map of the world. Players log in with the player password; the admin password also shows characters, inventories and the console.">
      <Row label="Create the website" sub={form.enabled ? `https://<server address>:${form.port}` : undefined}><Switch on={form.enabled} onChange={(v) => set({ enabled: v })} /></Row>
      {form.enabled && (
        <>
          <Row label="Player password" help="Shared with your players. Shows status, players online, world info and the map." sub={form.player && form.player.length < 4 ? <span style={{ color: 'var(--red)' }}>At least 4 characters</span> : undefined}>
            <input className="input" type="password" style={{ width: 200 }} value={form.player} onChange={(e) => set({ player: e.target.value })} autoComplete="new-password" />
          </Row>
          <Row label="Admin password" help="Only for you. Also shows characters, inventories, statistics and the console log." sub={form.admin && form.admin.length < 6 ? <span style={{ color: 'var(--red)' }}>At least 6 characters</span> : form.admin && form.admin === form.player ? <span style={{ color: 'var(--red)' }}>Must differ from the player password</span> : undefined}>
            <input className="input" type="password" style={{ width: 200 }} value={form.admin} onChange={(e) => set({ admin: e.target.value })} autoComplete="new-password" />
          </Row>
          <Row label="Website port" help={`HTTPS port of the website (the game uses ${gamePort}; both can't share one port). Open it in your firewall/router to reach the site from outside.`}>
            <input className="input" type="number" style={{ width: 100 }} value={form.port} onChange={(e) => set({ port: +e.target.value || 0 })} />
          </Row>
        </>
      )}
    </Section>
  )
}

/** Applies the wizard website settings to a freshly created server. */
export async function setupWebsite(hostId: string, dir: string, game: 'minecraft' | 'terraria', title: string, f: WebsiteForm): Promise<WebSettings | undefined> {
  if (!f.enabled) return undefined
  const web = { ...defaultWeb(0), port: f.port }
  if (!(await portFree(hostId, f.port))) throw new Error(`Port ${f.port} is already in use on this machine. Choose another website port in the server's Website tab.`)
  await configureWebsite(hostId, dir, { game, title, web, playerPassword: f.player, adminPassword: f.admin })
  return web
}

// ---------------------------------------------------------------------------
// Website tab

export function WebsiteTab() {
  const { srv, host, saveCfg } = useCtx()
  const game: 'minecraft' | 'terraria' = (srv.config as any).game === 'terraria' ? 'terraria' : 'minecraft'
  const cur: WebSettings = { ...defaultWeb(srv.port), ...((srv.config as any).web ?? {}) }
  const [st, setSt] = useState<WebStatus | null>(null)
  const [form, setForm] = useState<WebSettings>(cur)
  const [pw, setPw] = useState({ player: '', admin: '' })
  const [busy, setBusy] = useState('')

  const load = () => websiteStatus(srv.hostId, srv.dir).then(setSt).catch((e) => toast({ title: 'Could not read the website status', body: e.message, kind: 'error' }))
  useEffect(() => { load() }, [srv.dir]) // eslint-disable-line
  useEffect(() => { setForm({ ...defaultWeb(srv.port), ...((srv.config as any).web ?? {}) }) }, [srv.dir]) // eslint-disable-line

  const save = async (enabled = form.enabled) => {
    const next = { ...form, enabled }
    if (enabled && !st?.hasAdmin && pw.admin.length < 6) return toast({ title: 'Choose an admin password (at least 6 characters)', kind: 'error' })
    if (enabled && !st?.hasPlayer && pw.player.length < 4) return toast({ title: 'Choose a player password (at least 4 characters)', kind: 'error' })
    if (pw.admin && pw.admin.length < 6) return toast({ title: 'The admin password needs at least 6 characters', kind: 'error' })
    if (pw.player && pw.player.length < 4) return toast({ title: 'The player password needs at least 4 characters', kind: 'error' })
    if (pw.admin && pw.player && pw.admin === pw.player) return toast({ title: 'Use different player and admin passwords', kind: 'error' })
    setBusy('save')
    try {
      if (enabled && (st?.state !== 'running' || next.port !== st?.port) && !(await portFree(srv.hostId, next.port))) throw new Error(`Port ${next.port} is already in use on this machine.`)
      await configureWebsite(srv.hostId, srv.dir, {
        game, title: srv.config.name, web: next,
        playerPassword: pw.player || undefined, adminPassword: pw.admin || undefined,
      })
      await saveCfg({ web: next } as any)
      setForm(next)
      setPw({ player: '', admin: '' })
      toast({ title: enabled ? 'Website is online' : 'Website turned off', kind: 'success' })
    } catch (e: any) {
      toast({ title: 'Could not update the website', body: e.message, kind: 'error' })
    } finally {
      setBusy('')
      load()
    }
  }

  const act = async (a: 'start' | 'stop' | 'restart') => {
    setBusy(a)
    const r = await webctl(srv.hostId, srv.dir, a).catch((e) => ({ stdout: e.message, stderr: '', code: 1 }))
    if (a !== 'stop' && !/started|running/.test(r.stdout)) toast({ title: 'The website did not start', body: (r.stdout + r.stderr).slice(-400), kind: 'error' })
    setBusy('')
    load()
  }

  const addrs = [...new Set([host.host, ...(st?.ips ?? [])])].filter(Boolean)
  const urls = addrs.map((a) => `https://${a.includes(':') ? `[${a}]` : a}:${st?.port ?? form.port}`)

  return (
    <div className="grow scroll pad" style={{ maxWidth: 860, width: '100%', margin: '0 auto' }}>
      <div className="card" style={{ marginBottom: 16, display: 'flex', gap: 14, alignItems: 'center' }}>
        <Globe size={28} style={{ color: st?.state === 'running' ? 'var(--green)' : 'var(--text-3)' }} />
        <div className="grow">
          <b>Server website</b>
          <div className="small muted">
            {!st ? 'Checking…' : st.state === 'running' ? 'Online. Players log in with the player password; you with the admin password.' : st.state === 'none' ? 'Not set up yet. Choose passwords below and turn it on.' : st.state === 'disabled' ? 'Turned off.' : 'Stopped.'}
          </div>
        </div>
        {st?.configured && st.state !== 'disabled' && (st.state === 'running'
          ? <><button className="btn" disabled={!!busy} onClick={() => act('restart')}>{busy === 'restart' ? <Spinner size={12} /> : <RefreshCw size={12} />} Restart</button><button className="btn" disabled={!!busy} onClick={() => act('stop')}>Stop</button></>
          : <button className="btn primary" disabled={!!busy} onClick={() => act('start')}>{busy === 'start' ? <Spinner size={12} /> : null} Start</button>)}
      </div>

      {st?.firewall && st.state !== 'none' && (
        <div className="card" style={{ marginBottom: 16, borderLeft: '3px solid var(--orange)', lineHeight: 1.5 }}>
          <b>This server has a firewall ({st.firewall})</b>
          <div className="small" style={{ marginTop: 4 }}>
            If the website (port {st.port ?? form.port}) or the game (port {srv.port}) can't be reached from other computers, open both ports. This needs your server password (sudo) once.
          </div>
          <button className="btn primary" style={{ marginTop: 8 }} onClick={() => launch('terminal', { serverId: srv.hostId, forceNew: true, props: { command: openPortsCommand(st.firewall!, [st.port ?? form.port, srv.port]) } })}>
            Open Ports {st.port ?? form.port} and {srv.port} in Terminal
          </button>
          <div className="small muted" style={{ marginTop: 6 }}>Some hosting providers also have a firewall in their web control panel; allow the same ports there if it still doesn't work.</div>
        </div>
      )}

      {st?.state === 'running' && (
        <Section title="Address" help="The page uses a self-signed certificate, so the browser shows a one-time warning: choose “Advanced → Continue/Proceed”. Compare the fingerprint below with the one the browser shows to be sure it is your server.">
          {urls.map((u) => (
            <Row key={u} label={<span className="mono">{u}</span>}>
              <div className="row">
                <button className="btn" onClick={() => copy(u, 'Address copied')}><Copy size={12} /> Copy</button>
                <button className="btn" onClick={() => api.openExternal(u)}><ExternalLink size={12} /> Open</button>
              </div>
            </Row>
          ))}
          {st.fingerprint && <Row label="Certificate fingerprint (SHA-256)" sub={<span className="mono" style={{ fontSize: 10.5, wordBreak: 'break-all' }}>{st.fingerprint}</span>}><Shield size={14} /></Row>}
        </Section>
      )}

      <Section title="Settings">
        <Row label="Website enabled" help="Starts with the server and on boot, and is restarted if it stops."><Switch on={form.enabled} onChange={(v) => { setForm({ ...form, enabled: v }); if (st?.configured || !v) save(v) }} /></Row>
        <Row label="Port" help={`HTTPS port (the game server uses ${srv.port}). Open it in your firewall or router to reach the website from the internet.`}>
          <input className="input" type="number" style={{ width: 100 }} value={form.port} onChange={(e) => setForm({ ...form, port: +e.target.value || 0 })} />
        </Row>
        <Row label="Update the map every" help="How often the world map is redrawn (only when the world changed). Drawing runs at low priority.">
          <select className="select" style={{ width: 140 }} value={form.mapEvery} onChange={(e) => setForm({ ...form, mapEvery: +e.target.value })}>
            {[5, 10, 30, 60, 180].map((m) => <option key={m} value={m}>{m < 60 ? `${m} minutes` : `${m / 60} hour${m > 60 ? 's' : ''}`}</option>)}
          </select>
        </Row>
        {game === 'minecraft' && (
          <Row label="Map area" help="Blocks around spawn that the map shows. Bigger areas take longer to draw.">
            <select className="select" style={{ width: 140 }} value={form.mapRadius} onChange={(e) => setForm({ ...form, mapRadius: +e.target.value })}>
              {[512, 1024, 2048, 4096].map((r) => <option key={r} value={r}>±{r} blocks</option>)}
            </select>
          </Row>
        )}
      </Section>

      <Section title="Passwords" help="Stored only as salted hashes (PBKDF2) on the server. Leave a field empty to keep the current password.">
        <Row label={<span className="row" style={{ gap: 6 }}><Lock size={12} /> Player password</span>} sub={st?.hasPlayer ? 'Set' : <span style={{ color: 'var(--orange)' }}>Not set</span>}>
          <input className="input" type="password" style={{ width: 200 }} placeholder={st?.hasPlayer ? 'New password' : 'At least 4 characters'} value={pw.player} onChange={(e) => setPw({ ...pw, player: e.target.value })} autoComplete="new-password" />
        </Row>
        <Row label={<span className="row" style={{ gap: 6 }}><Shield size={12} /> Admin password</span>} sub={st?.hasAdmin ? 'Set' : <span style={{ color: 'var(--orange)' }}>Not set</span>}>
          <input className="input" type="password" style={{ width: 200 }} placeholder={st?.hasAdmin ? 'New password' : 'At least 6 characters'} value={pw.admin} onChange={(e) => setPw({ ...pw, admin: e.target.value })} autoComplete="new-password" />
        </Row>
      </Section>

      <div className="row" style={{ justifyContent: 'flex-end', marginBottom: 18 }}>
        <button className="btn primary" disabled={!!busy} onClick={() => save(form.enabled || !st?.configured)}>{busy === 'save' ? <Spinner size={12} /> : null} {st?.configured ? 'Save' : 'Create Website'}</button>
      </div>

      {st?.log && (
        <Section title="Website log">
          <pre className="output card" style={{ margin: 0, maxHeight: 180, overflow: 'auto', fontSize: 11 }}>{st.log}</pre>
        </Section>
      )}
      <div className="small muted" style={{ lineHeight: 1.6 }}>
        The website is read-only: it shows information but can't change anything on the server. It needs Python 3 and OpenSSL on the server (preinstalled on most Linux systems).
      </div>
    </div>
  )
}
