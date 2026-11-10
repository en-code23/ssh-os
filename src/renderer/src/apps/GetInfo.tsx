import { useEffect, useState } from 'react'
import type { FileEntry } from '../../../shared/types'
import { api, shq } from '../lib/api'
import { toast, useStore, Win } from '../lib/store'
import { category, ext, formatBytes, formatDate, isDirLike, kindLabel, parentPath } from '../lib/files'
import { FileIcon } from '../components/ui'
import { fsChanged } from '../lib/actions'

const BITS = [
  ['Owner', 6],
  ['Group', 3],
  ['Everyone', 0],
] as const

export function GetInfo({ win }: { win: Win }) {
  const serverId = win.serverId!
  const server = useStore((s) => s.servers.find((x) => x.id === serverId))
  const entry: FileEntry = win.props.entry
  const [mode, setMode] = useState(entry.mode ?? 0)
  const [size, setSize] = useState<string | null>(null)
  const isSSH = server?.protocol === 'ssh'

  useEffect(() => {
    if (isDirLike(entry) && isSSH) {
      setSize('Calculating…')
      api
        .exec(serverId, `du -sb ${shq(entry.path)} 2>/dev/null | cut -f1; find ${shq(entry.path)} 2>/dev/null | wc -l`, 120000)
        .then((r) => {
          const [b, n] = r.stdout.trim().split('\n')
          setSize(`${formatBytes(+b)} on disk (${Math.max(0, +n - 1)} items)`)
        })
        .catch(() => setSize('--'))
    }
  }, [entry.path]) // eslint-disable-line

  const toggle = (shift: number, bit: number) => setMode((m) => m ^ (bit << shift))
  const changed = mode !== (entry.mode ?? 0)

  const apply = async () => {
    try {
      await api.fs.chmod(serverId, entry.path, mode)
      entry.mode = mode
      fsChanged(serverId, parentPath(entry.path))
      toast({ title: 'Permissions updated', body: `${entry.name}: ${mode.toString(8).padStart(3, '0')}`, kind: 'success' })
    } catch (e: any) {
      toast({ title: 'Couldn’t change permissions', body: e.message, kind: 'error' })
    }
  }

  const Row = ({ k, v }: { k: string; v: string }) => (
    <div className="row" style={{ alignItems: 'flex-start', fontSize: 12 }}>
      <span className="muted" style={{ width: 82, textAlign: 'right', flexShrink: 0 }}>{k}:</span>
      <span style={{ wordBreak: 'break-all', userSelect: 'text' }}>{v}</span>
    </div>
  )

  return (
    <div className="grow scroll" style={{ padding: 14 }}>
      <div className="row" style={{ gap: 10, marginBottom: 12 }}>
        <FileIcon cat={category(entry)} size={44} label={ext(entry.name)} />
        <div className="grow">
          <b style={{ wordBreak: 'break-all' }}>{entry.name}</b>
          <div className="small muted">{isDirLike(entry) ? size ?? '--' : formatBytes(entry.size)}</div>
        </div>
      </div>
      <div className="card col" style={{ gap: 5 }}>
        <Row k="Kind" v={kindLabel(entry)} />
        <Row k="Size" v={isDirLike(entry) ? size ?? '--' : `${entry.size.toLocaleString()} bytes (${formatBytes(entry.size)})`} />
        <Row k="Where" v={`${server?.name}:${parentPath(entry.path)}`} />
        <Row k="Modified" v={formatDate(entry.modified)} />
        {entry.owner && <Row k="Owner" v={`${entry.owner}${entry.group ? ' : ' + entry.group : ''}`} />}
      </div>
      <div className="sb-section" style={{ paddingLeft: 2 }}>Sharing & Permissions</div>
      <div className="card">
        <table className="table" style={{ fontSize: 12 }}>
          <thead>
            <tr><th style={{ position: 'static' }}>Name</th><th style={{ position: 'static' }}>Read</th><th style={{ position: 'static' }}>Write</th><th style={{ position: 'static' }}>Exec</th></tr>
          </thead>
          <tbody>
            {BITS.map(([label, shift]) => (
              <tr key={label}>
                <td>{label}</td>
                {[4, 2, 1].map((b) => (
                  <td key={b}>
                    <input type="checkbox" checked={!!(mode & (b << shift))} onChange={() => toggle(shift, b)} disabled={entry.mode === undefined} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        <div className="row" style={{ marginTop: 8, justifyContent: 'space-between' }}>
          <span className="mono small muted">{(mode & 0o777).toString(8).padStart(3, '0')} {entry.permissions?.[0] ?? ''}</span>
          <button className="btn primary" disabled={!changed} onClick={apply}>Apply</button>
        </div>
      </div>
    </div>
  )
}
