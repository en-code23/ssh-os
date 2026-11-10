import { useEffect, useRef, useState } from 'react'
import { Terminal as XTerm, ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Plus, X } from 'lucide-react'
import { api, isMac, uid } from '../lib/api'
import { closeWindow, ensureConnected, updateWindow, useStore, Win } from '../lib/store'
import { useWinAction } from '../components/Window'
import { useMenu } from '../components/ui'

const THEMES: Record<string, ITheme> = {
  dark: { background: '#1e1e1e', foreground: '#e6e6e6', cursor: '#e6e6e6', selectionBackground: 'rgba(120,150,255,.35)', black: '#000000', red: '#ff5f57', green: '#5af78e', yellow: '#f3f99d', blue: '#57c7ff', magenta: '#ff6ac1', cyan: '#9aedfe', white: '#f1f1f0', brightBlack: '#686868', brightRed: '#ff5c57', brightGreen: '#5af78e', brightYellow: '#f3f99d', brightBlue: '#57c7ff', brightMagenta: '#ff6ac1', brightCyan: '#9aedfe', brightWhite: '#ffffff' },
  light: { background: '#ffffff', foreground: '#1d1d1f', cursor: '#1d1d1f', selectionBackground: 'rgba(0,122,255,.25)', black: '#000000', red: '#c91b00', green: '#00a600', yellow: '#a68b00', blue: '#0225c7', magenta: '#c930c7', cyan: '#00a6b2', white: '#bfbfbf', brightBlack: '#686868', brightRed: '#ff6e67', brightGreen: '#3fc43f', brightYellow: '#b3a100', brightBlue: '#3456ff', brightMagenta: '#f75ff5', brightCyan: '#00c5c7', brightWhite: '#ffffff' },
  ocean: { background: '#0f1b2d', foreground: '#c8d3f5', cursor: '#82aaff', selectionBackground: 'rgba(130,170,255,.3)', black: '#1b1d2b', red: '#ff757f', green: '#c3e88d', yellow: '#ffc777', blue: '#82aaff', magenta: '#c099ff', cyan: '#86e1fc', white: '#828bb8', brightBlack: '#444a73', brightRed: '#ff757f', brightGreen: '#c3e88d', brightYellow: '#ffc777', brightBlue: '#82aaff', brightMagenta: '#c099ff', brightCyan: '#86e1fc', brightWhite: '#c8d3f5' },
  solarized: { background: '#002b36', foreground: '#93a1a1', cursor: '#93a1a1', selectionBackground: 'rgba(147,161,161,.3)', black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900', blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5', brightBlack: '#586e75', brightRed: '#cb4b16', brightGreen: '#93a1a1', brightYellow: '#839496', brightBlue: '#839496', brightMagenta: '#6c71c4', brightCyan: '#93a1a1', brightWhite: '#fdf6e3' },
}

function useTermTheme(): ITheme {
  const t = useStore((s) => s.settings.terminalTheme)
  const [dark, setDark] = useState(document.documentElement.classList.contains('dark'))
  useEffect(() => {
    const o = new MutationObserver(() => setDark(document.documentElement.classList.contains('dark')))
    o.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => o.disconnect()
  }, [])
  if (t === 'auto') return dark ? THEMES.dark : THEMES.light
  return THEMES[t]
}

interface Tab {
  id: string
  serverId: string
  title: string
  cwd?: string
  command?: string
}

function TermView({ tab, active, onTitle, onExit }: { tab: Tab; active: boolean; onTitle: (t: string) => void; onExit: () => void }) {
  const host = useRef<HTMLDivElement>(null)
  const term = useRef<XTerm | null>(null)
  const fit = useRef<FitAddon | null>(null)
  const theme = useTermTheme()
  const fontSize = useStore((s) => s.settings.terminalFontSize)
  const [state, setState] = useState<'connecting' | 'open' | 'exited' | 'error'>('connecting')
  const [err, setErr] = useState('')
  const [session, setSession] = useState(tab.id)

  useEffect(() => {
    const t = new XTerm({
      fontFamily: '"SF Mono", Menlo, Monaco, monospace',
      fontSize,
      cursorBlink: true,
      allowProposedApi: true,
      macOptionIsMeta: true,
      scrollback: 10000,
      theme,
    })
    const f = new FitAddon()
    t.loadAddon(f)
    t.loadAddon(new WebLinksAddon((_e, uri) => api.openExternal(uri)))
    t.open(host.current!)
    term.current = t
    fit.current = f
    requestAnimationFrame(() => {
      try { f.fit() } catch { /* hidden */ }
    })

    const sid = session
    let disposed = false
    const offData = api.on('term:data', (p: { id: string; data: string }) => p.id === sid && t.write(p.data))
    const offExit = api.on('term:exit', (p: { id: string }) => {
      if (p.id !== sid || disposed) return
      setState('exited')
      t.write('\r\n\x1b[90m[Process completed]\x1b[0m\r\n')
      onExit()
    })
    if (!isMac) {
      // Windows/Linux: Ctrl+C copies when text is selected (else sends ^C); Ctrl+V / Ctrl+Shift+V paste
      t.attachCustomKeyEventHandler((ev) => {
        if (ev.type !== 'keydown' || !ev.ctrlKey) return true
        const k = ev.key.toLowerCase()
        if (k === 'c' && (ev.shiftKey || t.hasSelection())) {
          api.copyText(t.getSelection())
          t.clearSelection()
          return false
        }
        if (k === 'v') {
          navigator.clipboard.readText().then((txt) => txt && t.paste(txt)).catch(() => {})
          return false
        }
        return true
      })
    }
    t.onData((d) => api.term.write(sid, d))
    t.onResize(({ cols, rows }) => api.term.resize(sid, cols, rows))
    t.onTitleChange((title) => onTitle(title))

    ;(async () => {
      if (!(await ensureConnected(tab.serverId))) {
        setState('error')
        setErr('Not connected')
        return
      }
      try {
        await api.term.open(tab.serverId, sid, t.cols, t.rows, tab.cwd)
        if (!disposed) setState('open')
        if (tab.command && sid === tab.id) setTimeout(() => api.term.write(sid, tab.command + '\n'), 400)
      } catch (e: any) {
        setState('error')
        setErr(e.message)
      }
    })()

    const ro = new ResizeObserver(() => {
      if (host.current?.offsetParent) {
        try { f.fit() } catch { /* ignore */ }
      }
    })
    ro.observe(host.current!)
    return () => {
      disposed = true
      ro.disconnect()
      offData()
      offExit()
      api.term.close(sid)
      t.dispose()
    }
  }, [session]) // eslint-disable-line

  useEffect(() => {
    if (term.current) term.current.options.theme = theme
  }, [theme])
  useEffect(() => {
    if (term.current) {
      term.current.options.fontSize = fontSize
      try { fit.current?.fit() } catch { /* ignore */ }
    }
  }, [fontSize])
  useEffect(() => {
    if (active) {
      requestAnimationFrame(() => {
        try { fit.current?.fit() } catch { /* ignore */ }
        term.current?.focus()
      })
    }
  }, [active])

  return (
    <div className="term-host" style={{ display: active ? 'block' : 'none', background: theme.background }}>
      <div ref={host} style={{ height: '100%' }} />
      {(state === 'connecting' || state === 'error') && (
        <div className="term-overlay">
          {state === 'connecting' ? <div className="spinner" /> : <div>{err}</div>}
        </div>
      )}
      {state === 'exited' && (
        <div style={{ position: 'absolute', right: 14, bottom: 12 }}>
          <button className="btn" onClick={() => { setState('connecting'); setSession(uid()) }}>Reconnect</button>
        </div>
      )}
    </div>
  )
}

export function Terminal({ win }: { win: Win }) {
  const servers = useStore((s) => s.servers)
  const theme = useTermTheme()
  const [tabs, setTabs] = useState<Tab[]>(() => [{ id: uid(), serverId: win.serverId!, title: '', cwd: win.props.cwd, command: win.props.command }])
  const [active, setActive] = useState(tabs[0].id)
  const menu = useMenu()

  const name = (id: string) => servers.find((s) => s.id === id)
  const addTab = (serverId = tabs.find((t) => t.id === active)?.serverId ?? win.serverId!) => {
    const t = { id: uid(), serverId, title: '' }
    setTabs((ts) => [...ts, t])
    setActive(t.id)
  }
  const closeTab = (id: string) => {
    const rest = tabs.filter((t) => t.id !== id)
    if (!rest.length) return closeWindow(win.id)
    setTabs(rest)
    if (active === id) setActive(rest[rest.length - 1].id)
  }

  useWinAction(win.id, (a) => {
    if (a === 'new-tab') addTab()
  })

  const activeTab = tabs.find((t) => t.id === active)
  useEffect(() => {
    if (!activeTab) return
    const s = name(activeTab.serverId)
    updateWindow(win.id, {
      serverId: activeTab.serverId,
      title: activeTab.title || (s ? `${s.username}@${s.host}` : 'Terminal'),
    })
  }, [active, activeTab?.title]) // eslint-disable-line

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: theme.background }}>
      <div className="term-tabs">
          {tabs.map((t) => {
            const s = name(t.serverId)
            return (
              <div key={t.id} className={`term-tab ${t.id === active ? 'on' : ''}`} onMouseDown={() => setActive(t.id)}>
                <button className="x" onMouseDown={(e) => e.stopPropagation()} onClick={() => closeTab(t.id)}>
                  <X size={11} />
                </button>
                <span className="status-dot connected" style={{ background: s?.color, boxShadow: 'none' }} />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.title || s?.name}</span>
              </div>
            )
          })}
          <button
            className="tb-btn"
            style={{ height: 30, borderRadius: 0, width: 34 }}
            title="New Tab (⌘T) — right-click to choose server"
            onClick={() => addTab()}
            onContextMenu={(e) =>
              menu.open(e, [
                { header: 'New Tab on…' },
                ...servers.filter((s) => s.protocol === 'ssh').map((s) => ({ label: s.name, onClick: () => ensureConnected(s.id).then((ok) => ok && addTab(s.id)) })),
              ])
            }
          >
            <Plus size={15} />
          </button>
      </div>
      {tabs.map((t) => (
        <TermView
          key={t.id}
          tab={t}
          active={t.id === active}
          onTitle={(title) => setTabs((ts) => ts.map((x) => (x.id === t.id ? { ...x, title } : x)))}
          onExit={() => {}}
        />
      ))}
      {menu.el}
    </div>
  )
}
