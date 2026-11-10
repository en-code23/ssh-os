import { useEffect, useRef, useState } from 'react'
import { api, shq, uid } from '../lib/api'
import { toast, useStore, Win } from '../lib/store'
import { Toolbar } from '../components/Window'
import { Segmented, Spinner } from '../components/ui'

type Tool = 'info' | 'ping' | 'trace' | 'ports' | 'dns' | 'http'

const HOST_RE = /^[A-Za-z0-9._:-]+$/
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g

export function NetworkUtility({ win }: { win: Win }) {
  const serverId = win.serverId!
  const server = useStore((s) => s.servers.find((x) => x.id === serverId))
  const [tool, setTool] = useState<Tool>('info')
  const [host, setHost] = useState('1.1.1.1')
  const [count, setCount] = useState(5)
  const [ports, setPorts] = useState('22,80,443,3306,5432,6379,8080')
  const [out, setOut] = useState('')
  const [running, setRunning] = useState(false)
  const sid = useRef<string | null>(null)
  const pre = useRef<HTMLPreElement>(null)

  useEffect(() => () => { if (sid.current) api.stream.stop(sid.current) }, [])
  useEffect(() => {
    if (pre.current) pre.current.scrollTop = pre.current.scrollHeight
  }, [out])

  const stream = (cmd: string) => {
    if (sid.current) api.stream.stop(sid.current)
    const id = uid()
    sid.current = id
    setOut('')
    setRunning(true)
    const off = api.on('stream:event', (e: { id: string; type: string; data?: string }) => {
      if (e.id !== id) return
      if (e.type === 'data') setOut((o) => (o + (e.data ?? '').replace(/\r/g, '').replace(ANSI, '')).slice(-200000))
      else {
        setRunning(false)
        off()
      }
    })
    api.stream.start(serverId, id, cmd).catch((e) => {
      setOut(`Error: ${e.message}`)
      setRunning(false)
      off()
    })
  }

  const stop = () => {
    if (sid.current) api.stream.stop(sid.current)
  }

  const run = () => {
    if (tool !== 'info' && !HOST_RE.test(host)) return toast({ title: 'Invalid host', body: 'Use a hostname or IP address.', kind: 'error' })
    const h = shq(host)
    switch (tool) {
      case 'info':
        return stream(
          `echo "== Hostname =="; hostname -f 2>/dev/null || hostname; echo; echo "== Addresses =="; (ip -br addr 2>/dev/null || ifconfig); echo; echo "== Routes =="; (ip route 2>/dev/null || route -n); echo; echo "== DNS =="; grep -v '^#' /etc/resolv.conf; echo; echo "== Public IP =="; (curl -s --max-time 4 https://api.ipify.org || wget -qO- -T 4 https://api.ipify.org || echo unavailable); echo; echo; echo "== Listening Ports =="; (ss -tulpn 2>/dev/null || netstat -tulpn 2>/dev/null) | head -60`,
        )
      case 'ping':
        return stream(`ping -c ${Math.max(1, Math.min(100, count))} ${h} 2>&1`)
      case 'trace':
        return stream(`(command -v traceroute >/dev/null && traceroute -w 2 ${h}) || (command -v tracepath >/dev/null && tracepath ${h}) || (command -v mtr >/dev/null && mtr -rwc 3 ${h}) || echo "traceroute is not installed on this server (try: sudo apt install traceroute)"`)
      case 'dns':
        return stream(`(command -v dig >/dev/null && dig +noall +answer ${h} ANY; dig +short ${h} A; dig +short ${h} AAAA; dig +short ${h} MX) || nslookup ${h} 2>&1 || getent hosts ${h}`)
      case 'http':
        return stream(`curl -sS -o /dev/null -w 'HTTP %{http_code}\\nIP: %{remote_ip}\\nDNS: %{time_namelookup}s\\nConnect: %{time_connect}s\\nTLS: %{time_appconnect}s\\nFirst byte: %{time_starttransfer}s\\nTotal: %{time_total}s\\nSize: %{size_download} bytes\\n' --max-time 15 ${shq(/^https?:/.test(host) ? host : 'https://' + host)} 2>&1; echo; curl -sSI --max-time 10 ${shq(/^https?:/.test(host) ? host : 'https://' + host)} 2>&1 | head -30`)
      case 'ports': {
        const list = ports.split(/[\s,]+/).filter((p) => /^\d+(-\d+)?$/.test(p))
        const expanded: number[] = []
        for (const p of list) {
          const [a, b] = p.split('-').map(Number)
          for (let i = a; i <= (b ?? a) && expanded.length < 1024; i++) expanded.push(i)
        }
        if (!expanded.length) return toast({ title: 'Enter ports, e.g. 22,80,8000-8100', kind: 'error' })
        return stream(
          `for p in ${expanded.join(' ')}; do (timeout 1 bash -c "</dev/tcp/${host}/$p" 2>/dev/null && echo "Port $p  open") || echo "Port $p  closed"; done 2>&1 | grep -E "open|closed"`,
        )
      }
    }
  }

  return (
    <>
      <Toolbar>
        <div style={{ width: 84 }} />
        <div style={{ flex: 1 }}>
          <div className="toolbar-title" style={{ fontSize: 13 }}>Network Utility</div>
          <div className="small muted">from {server?.name}</div>
        </div>
        <Segmented
          value={tool}
          onChange={(t) => { setTool(t); setOut('') }}
          options={[
            { value: 'info', label: 'Info' },
            { value: 'ping', label: 'Ping' },
            { value: 'trace', label: 'Traceroute' },
            { value: 'ports', label: 'Port Scan' },
            { value: 'dns', label: 'Lookup' },
            { value: 'http', label: 'HTTP' },
          ]}
        />
      </Toolbar>
      <div className="col pad" style={{ flex: 1, minHeight: 0 }}>
        <div className="row">
          {tool !== 'info' && (
            <input
              className="input"
              style={{ flex: 1 }}
              value={host}
              onChange={(e) => setHost(e.target.value.trim())}
              placeholder={tool === 'http' ? 'https://example.com' : 'Host name or IP address'}
              onKeyDown={(e) => e.key === 'Enter' && run()}
            />
          )}
          {tool === 'ping' && (
            <label className="row small muted">
              Count <input className="input" style={{ width: 56 }} type="number" value={count} onChange={(e) => setCount(+e.target.value)} />
            </label>
          )}
          {tool === 'ports' && (
            <input className="input mono" style={{ flex: 1 }} value={ports} onChange={(e) => setPorts(e.target.value)} placeholder="22,80,443,8000-8100" />
          )}
          {tool === 'info' && <div className="grow muted">Interfaces, routes, DNS and listening ports of {server?.name}</div>}
          {running ? (
            <button className="btn" onClick={stop}><Spinner size={12} /> Stop</button>
          ) : (
            <button className="btn primary" onClick={run}>{tool === 'info' ? 'Refresh' : tool === 'ports' ? 'Scan' : 'Run'}</button>
          )}
        </div>
        <pre ref={pre} className="output card" style={{ flex: 1, margin: 0, overflow: 'auto' }}>
          {out ? colorize(out) : <span className="muted">Output will appear here.</span>}
        </pre>
      </div>
    </>
  )
}

function colorize(s: string) {
  return s.split('\n').map((l, i) => (
    <div key={i} style={{ color: / open$/.test(l) ? 'var(--green)' : /^== /.test(l) ? 'var(--accent)' : undefined, fontWeight: /^== /.test(l) ? 600 : undefined }}>
      {l || ' '}
    </div>
  ))
}
