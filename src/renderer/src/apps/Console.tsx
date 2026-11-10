import { useEffect, useMemo, useRef, useState } from 'react'
import { Pause, Play, Search, Trash2, FileText, Plus } from 'lucide-react'
import { api, shq, uid } from '../lib/api'
import { prompt, useStore, Win } from '../lib/store'
import { Toolbar } from '../components/Window'

interface Source { id: string; name: string; cmd: string; follow: string }

const fileSrc = (name: string, path: string): Source => ({
  id: path, name, cmd: `tail -n 500 ${shq(path)} 2>&1 || sudo -n tail -n 500 ${shq(path)} 2>&1`, follow: `tail -n 200 -F ${shq(path)} 2>&1`,
})

const SOURCES: Source[] = [
  { id: 'journal', name: 'System Journal', cmd: 'journalctl -n 500 --no-pager 2>&1', follow: 'journalctl -n 200 -f --no-pager 2>&1' },
  { id: 'kernel', name: 'Kernel (dmesg)', cmd: 'dmesg -T 2>&1 | tail -n 500 || journalctl -k -n 500 --no-pager', follow: 'dmesg -Tw 2>&1 || journalctl -k -f --no-pager' },
  { id: 'errors', name: 'Errors (journal)', cmd: 'journalctl -p err -n 500 --no-pager 2>&1', follow: 'journalctl -p err -n 100 -f --no-pager 2>&1' },
  fileSrc('syslog', '/var/log/syslog'),
  fileSrc('auth.log', '/var/log/auth.log'),
  fileSrc('nginx access', '/var/log/nginx/access.log'),
  fileSrc('nginx error', '/var/log/nginx/error.log'),
  fileSrc('apache error', '/var/log/apache2/error.log'),
]

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g

export function Console({ win }: { win: Win }) {
  const serverId = win.serverId!
  const server = useStore((s) => s.servers.find((x) => x.id === serverId))
  const initial: Source | undefined = win.props.source
    ? { id: 'custom:' + win.props.source, name: 'Custom', cmd: win.props.source, follow: win.props.source.replace(/-n \d+/, '-n 100') + ' -f' }
    : undefined
  const [custom, setCustom] = useState<Source[]>(() => {
    try {
      return JSON.parse(localStorage.getItem('console:custom') || '[]')
    } catch {
      return []
    }
  })
  const [src, setSrc] = useState<Source>(initial ?? SOURCES[0])
  const [lines, setLines] = useState<string[]>([])
  const [follow, setFollow] = useState<boolean>(!!win.props.follow)
  const [q, setQ] = useState('')
  const [loading, setLoading] = useState(false)
  const scroller = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const streamId = useRef<string | null>(null)
  const partial = useRef('')

  useEffect(() => {
    let cancelled = false
    setLines([])
    partial.current = ''
    stick.current = true
    if (follow) {
      const sid = uid()
      streamId.current = sid
      const off = api.on('stream:event', (e: { id: string; type: string; data?: string }) => {
        if (e.id !== sid || e.type !== 'data') return
        const text = partial.current + (e.data ?? '').replace(/\r/g, '').replace(ANSI, '')
        const parts = text.split('\n')
        partial.current = parts.pop() ?? ''
        if (parts.length) setLines((l) => [...l, ...parts].slice(-5000))
      })
      api.stream.start(serverId, sid, src.follow).catch((e) => setLines([`Error: ${e.message}`]))
      return () => {
        off()
        api.stream.stop(sid)
      }
    }
    setLoading(true)
    api
      .exec(serverId, src.cmd)
      .then((r) => !cancelled && setLines((r.stdout + r.stderr).replace(ANSI, '').split('\n')))
      .catch((e) => !cancelled && setLines([`Error: ${e.message}`]))
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [src, follow, serverId])

  useEffect(() => {
    if (stick.current && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight
  }, [lines])

  const shown = useMemo(() => (q ? lines.filter((l) => l.toLowerCase().includes(q.toLowerCase())) : lines), [lines, q])

  const hl = (l: string) => {
    if (!q) return l
    const i = l.toLowerCase().indexOf(q.toLowerCase())
    if (i < 0) return l
    return (
      <>
        {l.slice(0, i)}
        <mark>{l.slice(i, i + q.length)}</mark>
        {l.slice(i + q.length)}
      </>
    )
  }

  const addCustom = async () => {
    const p = await prompt('Add Log File', '/var/log/', 'Path to a log file on the server', 'Add')
    if (!p) return
    const s = fileSrc(p.split('/').pop() || p, p)
    const n = [...custom.filter((c) => c.id !== s.id), s]
    setCustom(n)
    try { localStorage.setItem('console:custom', JSON.stringify(n)) } catch { /* ignore */ }
    setSrc(s)
  }

  const all = [...(initial ? [initial] : []), ...SOURCES, ...custom]

  return (
    <>
      <Toolbar>
        <div style={{ width: 84 }} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="toolbar-title" style={{ fontSize: 13 }}>{src.name}</div>
          <div className="small muted">{server?.name} · {shown.length} lines</div>
        </div>
        <button className={`tb-btn ${follow ? 'on' : ''}`} title={follow ? 'Pause live stream' : 'Stream live'} onClick={() => setFollow(!follow)}>
          {follow ? <Pause size={16} /> : <Play size={16} />} <span style={{ fontSize: 12 }}>{follow ? 'Live' : 'Start'}</span>
        </button>
        <button className="tb-btn" title="Clear" onClick={() => setLines([])}>
          <Trash2 size={16} />
        </button>
        <div className="search">
          <Search size={13} />
          <input placeholder="Filter" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </Toolbar>
      <div className="split">
        <div className="sidebar" style={{ width: 180 }}>
          <div className="sb-section">Reports</div>
          {all.map((s) => (
            <div key={s.id} className={`sb-item ${src.id === s.id ? 'active' : ''}`} onClick={() => setSrc(s)} title={s.cmd}>
              <FileText size={15} className="ico" />
              <span className="grow">{s.name}</span>
            </div>
          ))}
          <div className="sb-item" onClick={addCustom} style={{ color: 'var(--text-2)' }}>
            <Plus size={15} className="ico" />
            <span className="grow">Add Log File…</span>
          </div>
        </div>
        <div
          ref={scroller}
          className="grow scroll"
          style={{ background: 'var(--win-bg)', paddingTop: 6, userSelect: 'text' }}
          onScroll={(e) => {
            const el = e.currentTarget
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
          }}
        >
          {loading && <div className="empty">Loading…</div>}
          {shown.map((l, i) => (
            <div key={i} className={`log-line ${/\b(error|err|fail(ed|ure)?|fatal|crit(ical)?|panic|denied)\b/i.test(l) ? 'err' : /\b(warn(ing)?)\b/i.test(l) ? 'warn' : ''}`}>
              {hl(l)}
            </div>
          ))}
        </div>
      </div>
    </>
  )
}
