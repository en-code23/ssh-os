import { useEffect, useState } from 'react'
import { Copy } from 'lucide-react'
import { api, shq } from '../../lib/api'
import { toast } from '../../lib/store'
import { Switch, Spinner } from '../../components/ui'
import { Row, Section } from './common'

export interface DuplicateOptions {
  name: string
  dir: string
  port: number
  includeWorlds: boolean
  includeBackups: boolean
  startAfter: boolean
}

/**
 * Shell script that copies a server folder.
 *  - excludes runtime files (pid, session, logs) and optionally worlds/backups
 *  - `pre`/`post` run around the copy (e.g. pause world saving on a running Minecraft server)
 */
export function duplicateScript(src: string, dst: string, excludes: string[], pre = '', post = '') {
  const ex = excludes.map((e) => `--exclude=${shq('./' + e.replace(/^\.\//, ''))}`).join(' ')
  return `set -e
SRC=${shq(src)}; DST=${shq(dst)}
if [ -e "$DST" ] && [ -n "$(ls -A "$DST" 2>/dev/null)" ]; then echo "The folder $DST already exists and is not empty."; exit 3; fi
mkdir -p "$DST"
${pre}
trap '${post.replace(/'/g, `'\\''`)}' EXIT
echo "Copying $SRC → $DST …"
cd "$SRC" && tar cf - ${ex} . | (cd "$DST" && tar xf -)
echo "Copied $(du -sh "$DST" | cut -f1)."`
}

export function DuplicateSheet({
  hostId,
  srcName,
  srcDir,
  usedPorts,
  defaultPort,
  worldsLabel,
  running,
  onCancel,
  onConfirm,
}: {
  hostId: string
  srcName: string
  srcDir: string
  usedPorts: number[]
  defaultPort: number
  worldsLabel: string
  running: boolean
  onCancel: () => void
  onConfirm: (o: DuplicateOptions) => void
}) {
  const parent = srcDir.replace(/\/[^/]+\/?$/, '') || '/'
  const base = srcDir.split('/').filter(Boolean).pop() ?? 'server'
  const [o, setO] = useState<DuplicateOptions>({
    name: `${srcName} copy`,
    dir: `${parent}/${base}-copy`,
    port: defaultPort,
    includeWorlds: true,
    includeBackups: false,
    startAfter: false,
  })
  const [checking, setChecking] = useState(true)
  const [dirExists, setDirExists] = useState(false)
  const [portBusy, setPortBusy] = useState(false)

  // next free port and a folder name that doesn't exist yet
  useEffect(() => {
    let p = defaultPort + 1
    while (usedPorts.includes(p)) p++
    setO((x) => ({ ...x, port: p }))
    api
      .exec(hostId, `for i in '' 2 3 4 5 6 7 8 9; do d=${shq(`${parent}/${base}-copy`)}$i; [ -e "$d" ] || { echo "$d"; break; }; done`)
      .then((r) => {
        const d = r.stdout.trim()
        if (d) setO((x) => ({ ...x, dir: d, name: d.endsWith('-copy') ? x.name : `${srcName} copy ${d.match(/(\d+)$/)?.[1] ?? ''}`.trim() }))
      })
      .finally(() => setChecking(false))
  }, []) // eslint-disable-line

  useEffect(() => {
    const t = setTimeout(() => {
      api.exec(hostId, `[ -e ${shq(o.dir)} ] && echo EXISTS; (ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null) | grep -qE '[:.]${o.port}\\s' && echo BUSY; true`).then((r) => {
        setDirExists(r.stdout.includes('EXISTS'))
        setPortBusy(r.stdout.includes('BUSY') || usedPorts.includes(o.port))
      })
    }, 300)
    return () => clearTimeout(t)
  }, [o.dir, o.port]) // eslint-disable-line

  const valid = o.name.trim() && o.dir.startsWith('/') && !dirExists && o.port > 0 && o.port < 65536 && o.dir !== srcDir
  return (
    <div className="modal-backdrop" style={{ position: 'absolute', paddingTop: 30, zIndex: 40 }} onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="sheet" style={{ width: 560 }}>
        <h3>Duplicate “{srcName}”</h3>
        <div className="small muted" style={{ marginTop: -10, marginBottom: 14 }}>
          Makes an independent copy with its own folder, port and schedules. Good for testing updates or plugins without touching the original.
        </div>
        <Section title="Copy">
          <Row label="Name"><input className="input" style={{ width: 260 }} value={o.name} onChange={(e) => setO({ ...o, name: e.target.value })} /></Row>
          <Row label="Folder" sub={dirExists ? <span style={{ color: 'var(--red)' }}>This folder already exists</span> : undefined}>
            {checking ? <Spinner size={12} /> : <input className="input mono" style={{ width: 300 }} value={o.dir} onChange={(e) => setO({ ...o, dir: e.target.value.replace(/\/+$/, '') })} />}
          </Row>
          <Row label="Port" help="Two servers on one machine can't share a port. The next free port is chosen for you." sub={portBusy ? <span style={{ color: 'var(--orange)' }}>Port in use on this machine</span> : undefined}>
            <input className="input" type="number" style={{ width: 100 }} value={o.port} onChange={(e) => setO({ ...o, port: +e.target.value || 0 })} />
          </Row>
        </Section>
        <Section title="What to copy">
          <Row label={`Copy ${worldsLabel}`} help={`Off: the copy starts with fresh ${worldsLabel} but keeps all settings, plugins and mods.`}><Switch on={o.includeWorlds} onChange={(v) => setO({ ...o, includeWorlds: v })} /></Row>
          <Row label="Copy backups"><Switch on={o.includeBackups} onChange={(v) => setO({ ...o, includeBackups: v })} /></Row>
          <Row label="Start the copy when done"><Switch on={o.startAfter} onChange={(v) => setO({ ...o, startAfter: v })} /></Row>
        </Section>
        {running && <div className="small muted">The original keeps running. Saving is paused briefly so the copied world is consistent.</div>}
        <div className="sheet-actions">
          <button className="btn" onClick={onCancel}>Cancel</button>
          <button className="btn primary" disabled={!valid} onClick={() => (valid ? onConfirm({ ...o, name: o.name.trim() }) : toast({ title: 'Check the folder and port' }))}>
            <Copy size={12} /> Duplicate
          </button>
        </div>
      </div>
    </div>
  )
}
