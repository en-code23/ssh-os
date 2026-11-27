import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  ArrowUp, Archive, Brain, Check, ChevronDown, ChevronRight, FileCode2, FolderOpen, ListChecks, MessageSquarePlus,
  RefreshCw, ShieldAlert, Square, SquareTerminal, Wrench, X,
} from 'lucide-react'
import { toast } from '../../lib/store'
import { CodexClient, type ServerRequest } from '../../lib/codex/client'
import { Spinner } from '../../components/ui'
import { launch } from '../launch'

// ---------------------------------------------------------------------------
// types (subset of the Codex app-server protocol)

type Mode = 'auto' | 'ask' | 'readonly' | 'full'
const MODES: { v: Mode; label: string; help: string; approvalPolicy: string; sandbox: string }[] = [
  { v: 'auto', label: 'Auto', help: 'Codex edits files and runs commands inside the folder; asks before anything outside it or with network access.', approvalPolicy: 'on-request', sandbox: 'workspace-write' },
  { v: 'ask', label: 'Ask first', help: 'Codex asks before running commands (except simple reads).', approvalPolicy: 'untrusted', sandbox: 'workspace-write' },
  { v: 'readonly', label: 'Read only', help: 'Codex can read files and answer questions but not change anything.', approvalPolicy: 'on-request', sandbox: 'read-only' },
  { v: 'full', label: 'Full access', help: 'No sandbox and no questions: Codex can change anything your user can. Only for trusted tasks.', approvalPolicy: 'never', sandbox: 'danger-full-access' },
]

interface ThreadInfo { id: string; preview: string; cwd: string; updatedAt: number; name?: string | null }
type Entry =
  | { key: string; kind: 'item'; item: any; turnId: string }
  | { key: string; kind: 'error'; text: string }
  | { key: string; kind: 'plan'; turnId: string; explanation: string | null; plan: { step: string; status: string }[] }
interface Pending { id: number | string; method: string; params: any; resolve: (v: any) => void }

const short = (p: string, home: string) => (home && p.startsWith(home) ? '~' + p.slice(home.length) : p)
const ago = (s: number) => {
  const d = Date.now() / 1000 - s
  return d < 60 ? 'just now' : d < 3600 ? `${Math.floor(d / 60)} min` : d < 86400 ? `${Math.floor(d / 3600)} h` : new Date(s * 1000).toLocaleDateString()
}

// ---------------------------------------------------------------------------

export function CodexChat({ hostId, codexPath, home, folders, onSetup }: { hostId: string; codexPath: string; home: string; folders: string[]; onSetup: () => void }) {
  const [client, setClient] = useState<CodexClient | null>(null)
  const [state, setState] = useState<'connecting' | 'ready' | 'error'>('connecting')
  const [error, setError] = useState('')
  const [account, setAccount] = useState('')
  const [threads, setThreads] = useState<ThreadInfo[]>([])
  const [thread, setThread] = useState<{ id: string; cwd: string } | null>(null)
  const [entries, setEntries] = useState<Entry[]>([])
  const [running, setRunning] = useState<string | null>(null)
  const [pending, setPending] = useState<Pending[]>([])
  const [usage, setUsage] = useState<{ total: number; window: number | null } | null>(null)
  const [models, setModels] = useState<{ model: string; displayName: string; efforts: string[]; defaultEffort: string }[]>([])
  const [model, setModel] = useState('')
  const [effort, setEffort] = useState('')
  const [text, setText] = useState('')
  const [folder, setFolder] = useState(home)
  const [mode, setMode] = useState<Mode>('auto')
  const [loadingThread, setLoadingThread] = useState(false)
  const [nonce, setNonce] = useState(0)
  const threadRef = useRef<string | null>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const sending = useRef(false)

  // ---- connection
  useEffect(() => {
    const c = new CodexClient(hostId, codexPath)
    let alive = true
    setState('connecting'); setError(''); setThread(null); setEntries([]); setPending([]); setRunning(null)
    c.onExit = (reason) => { if (!alive) return; setState('error'); setError(`${reason}${c.lastErrors ? '\n' + c.lastErrors : ''}`); setRunning(null); setPending([]) }
    c.onServerRequest = (r: ServerRequest) => {
      // approvals and questions wait for the user
      if (/requestApproval$|requestUserInput$/.test(r.method)) return new Promise((resolve) => setPending((p) => [...p, { ...r, resolve }]))
      // older approval kinds: refuse
      if (r.method === 'applyPatchApproval' || r.method === 'execCommandApproval') return Promise.resolve({ decision: 'denied' })
      return Promise.reject(new Error(`${r.method} is not supported by SSH OS`))
    }
    c.start()
      .then(async () => {
        if (!alive) return c.stop()
        setClient(c)
        setState('ready')
        const acc = await c.request('account/read', {}).catch(() => null)
        const a = acc?.account
        setAccount(a?.type === 'chatgpt' ? `${a.email ?? 'ChatGPT'}${a.planType ? ` · ${a.planType}` : ''}` : a?.type === 'apiKey' ? 'API key' : '')
        const ml = await c.request('model/list', {}).catch(() => null)
        const list = (ml?.data ?? []).filter((m: any) => !m.hidden).map((m: any) => ({ model: m.model, displayName: m.displayName || m.model, efforts: (m.supportedReasoningEfforts ?? []).map((e: any) => e.reasoningEffort), defaultEffort: m.defaultReasoningEffort }))
        setModels(list)
        loadThreads(c)
      })
      .catch((e) => { if (alive) { setState('error'); setError(`${e.message}${c.lastErrors ? '\n' + c.lastErrors : ''}`) } })
    return () => { alive = false; c.stop() }
  }, [hostId, codexPath, nonce]) // eslint-disable-line

  const loadThreads = async (c = client) => {
    if (!c) return
    const r = await c.request('thread/list', { limit: 60, sortKey: 'updated_at', sortDirection: 'desc', archived: false }).catch(() => null)
    setThreads((r?.data ?? []).filter((t: any) => !t.parentThreadId && !t.ephemeral).map((t: any) => ({ id: t.id, preview: t.preview || 'New chat', cwd: t.cwd, updatedAt: t.updatedAt, name: t.name })))
  }

  // ---- notifications for the open thread
  useEffect(() => {
    if (!client) return
    return client.on(({ method, params }) => {
      if (method === 'thread/name/updated' || method === 'thread/started') loadThreads()
      if (!params || params.threadId !== threadRef.current) return
      switch (method) {
        case 'turn/started': setRunning(params.turn.id); break
        case 'turn/completed': {
          setRunning(null)
          const t = params.turn
          if (t.status === 'failed' && t.error?.message) addEntry({ key: 'err-' + t.id, kind: 'error', text: t.error.message })
          if (t.status === 'interrupted') addEntry({ key: 'int-' + t.id, kind: 'error', text: 'Stopped.' })
          loadThreads()
          break
        }
        case 'item/started':
        case 'item/completed':
          upsertItem(params.item, params.turnId)
          break
        case 'item/agentMessage/delta':
          patchItem(params.itemId, (it) => ({ ...it, text: (it.text ?? '') + params.delta }))
          break
        case 'item/reasoning/summaryTextDelta':
          patchItem(params.itemId, (it) => {
            const s = [...(it.summary ?? [])]
            s[params.summaryIndex] = (s[params.summaryIndex] ?? '') + params.delta
            return { ...it, summary: s }
          })
          break
        case 'item/commandExecution/outputDelta':
          patchItem(params.itemId, (it) => ({ ...it, aggregatedOutput: ((it.aggregatedOutput ?? '') + params.delta).slice(-20000) }))
          break
        case 'turn/plan/updated':
          setEntries((es) => {
            const key = 'plan-' + params.turnId
            const e: Entry = { key, kind: 'plan', turnId: params.turnId, explanation: params.explanation, plan: params.plan }
            return es.some((x) => x.key === key) ? es.map((x) => (x.key === key ? e : x)) : [...es, e]
          })
          break
        case 'thread/tokenUsage/updated':
          setUsage({ total: params.tokenUsage?.total?.totalTokens ?? 0, window: params.tokenUsage?.modelContextWindow ?? null })
          break
        case 'error':
          if (!params.willRetry) addEntry({ key: 'e-' + Date.now(), kind: 'error', text: params.error?.message ?? 'Error' })
          break
        case 'serverRequest/resolved':
          setPending((p) => p.filter((x) => x.id !== params.requestId))
          break
      }
    })
  }, [client]) // eslint-disable-line

  const addEntry = (e: Entry) => setEntries((es) => [...es, e])
  const upsertItem = (item: any, turnId: string) => setEntries((es) => {
    const i = es.findIndex((e) => e.kind === 'item' && e.item.id === item.id)
    if (i < 0) return [...es, { key: item.id, kind: 'item', item, turnId }]
    const prev = es[i] as Extract<Entry, { kind: 'item' }>
    // completed items carry the full text; keep streamed text if the final one is empty
    const merged = { ...prev.item, ...item, text: item.text || prev.item.text, aggregatedOutput: item.aggregatedOutput ?? prev.item.aggregatedOutput }
    const next = [...es]
    next[i] = { ...prev, item: merged }
    return next
  })
  const patchItem = (id: string, fn: (it: any) => any) => setEntries((es) => es.map((e) => (e.kind === 'item' && e.item.id === id ? { ...e, item: fn(e.item) } : e)))

  // ---- auto-scroll while at the bottom
  useEffect(() => {
    const el = scroller.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [entries, pending])

  // ---- threads
  const openThread = async (t: ThreadInfo) => {
    if (!client || loadingThread) return
    setLoadingThread(true)
    setEntries([]); setPending([]); setUsage(null); setRunning(null)
    threadRef.current = t.id
    setThread({ id: t.id, cwd: t.cwd })
    try {
      await client.request('thread/resume', { threadId: t.id, excludeTurns: true })
      const r = await client.request('thread/turns/list', { threadId: t.id, limit: 40, sortDirection: 'desc', itemsView: 'full' })
      const turns = [...(r?.data ?? [])].reverse()
      const es: Entry[] = []
      for (const turn of turns) {
        for (const item of turn.items ?? []) es.push({ key: item.id, kind: 'item', item, turnId: turn.id })
        if (turn.status === 'failed' && turn.error?.message) es.push({ key: 'err-' + turn.id, kind: 'error', text: turn.error.message })
        if (turn.status === 'inProgress') setRunning(turn.id)
      }
      if (threadRef.current === t.id) setEntries(es)
      stick.current = true
    } catch (e: any) {
      toast({ title: 'Could not open the chat', body: e.message, kind: 'error' })
    } finally {
      setLoadingThread(false)
    }
  }

  const newChat = () => {
    threadRef.current = null
    setThread(null); setEntries([]); setPending([]); setUsage(null); setRunning(null)
  }

  const archive = async (t: ThreadInfo) => {
    if (!client) return
    await client.request('thread/archive', { threadId: t.id }).catch((e) => toast({ title: 'Could not archive', body: e.message, kind: 'error' }))
    if (thread?.id === t.id) newChat()
    loadThreads()
  }

  // ---- sending
  const send = async () => {
    const msg = text.trim()
    if (!client || !msg || running || sending.current) return
    sending.current = true
    const m = MODES.find((x) => x.v === mode)!
    let id = thread?.id
    try {
      if (!id) {
        const r = await client.request('thread/start', { cwd: folder || home, approvalPolicy: m.approvalPolicy, sandbox: m.sandbox, ...(model ? { model } : {}) })
        id = r.thread.id as string
        threadRef.current = id
        setThread({ id, cwd: r.cwd ?? folder })
        if (!model && r.model) setModel(r.model)
      }
      setText('')
      stick.current = true
      const r = await client.request('turn/start', {
        threadId: id,
        input: [{ type: 'text', text: msg, text_elements: [] }],
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
      })
      if (r?.turn?.id) setRunning(r.turn.id)
    } catch (e: any) {
      setText(msg)
      toast({ title: 'Could not send', body: e.message, kind: 'error' })
    } finally {
      sending.current = false
    }
  }

  const stop = async () => {
    if (!client || !thread || !running) return
    await client.request('turn/interrupt', { threadId: thread.id, turnId: running }).catch(() => {})
  }

  const answer = (p: Pending, result: any) => {
    p.resolve(result)
    setPending((ps) => ps.filter((x) => x !== p))
  }

  const curModel = models.find((m) => m.model === model)
  const visiblePending = pending.filter((p) => p.params?.threadId === thread?.id)

  // ---------------------------------------------------------------------------
  if (state === 'connecting') return <div className="empty"><Spinner size={22} /><div className="small muted" style={{ marginTop: 10 }}>Starting Codex on the server…</div></div>
  if (state === 'error') {
    return (
      <div className="empty" style={{ maxWidth: 560, margin: '0 auto' }}>
        <h3>Codex could not start</h3>
        <pre className="output card" style={{ textAlign: 'left', whiteSpace: 'pre-wrap', maxHeight: 220, overflow: 'auto', fontSize: 11 }}>{error}</pre>
        <div className="row" style={{ justifyContent: 'center' }}>
          <button className="btn primary" onClick={() => setNonce((n) => n + 1)}><RefreshCw size={12} /> Try Again</button>
          <button className="btn" onClick={onSetup}>Open Setup</button>
        </div>
      </div>
    )
  }

  return (
    <div className="codex-chat">
      <aside className="codex-side">
        <button className="btn primary" style={{ width: '100%', justifyContent: 'center' }} onClick={newChat}><MessageSquarePlus size={13} /> New Chat</button>
        <div className="small muted" style={{ margin: '12px 4px 6px', display: 'flex', justifyContent: 'space-between' }}>
          <span>Recent</span>
          <button className="tb-btn" title="Refresh" onClick={() => loadThreads()}><RefreshCw size={11} /></button>
        </div>
        <div className="scroll grow">
          {threads.length === 0 && <div className="small muted" style={{ padding: 6 }}>No chats yet.</div>}
          {threads.map((t) => (
            <div key={t.id} className={`codex-thread ${thread?.id === t.id ? 'on' : ''}`} onClick={() => openThread(t)}>
              <div className="codex-thread-title">{t.name || t.preview}</div>
              <div className="codex-thread-sub">{short(t.cwd, home)} · {ago(t.updatedAt)}</div>
              <button className="codex-thread-x" title="Archive" onClick={(e) => { e.stopPropagation(); archive(t) }}><Archive size={11} /></button>
            </div>
          ))}
        </div>
        {account && <div className="small muted" style={{ padding: '8px 4px 0', borderTop: '1px solid var(--border)' }}>{account}</div>}
      </aside>

      <section className="codex-main">
        <div className="codex-head">
          <FolderOpen size={14} style={{ color: 'var(--text-3)' }} />
          {thread ? (
            <span className="mono small" title={thread.cwd}>{short(thread.cwd, home)}</span>
          ) : (
            <>
              <input className="input mono" style={{ width: 280, height: 26 }} value={folder} onChange={(e) => setFolder(e.target.value)} list="codex-chat-folders" />
              <datalist id="codex-chat-folders">{[home, ...folders].map((d) => <option key={d} value={d} />)}</datalist>
            </>
          )}
          <div className="grow" />
          {!thread && (
            <div className="segmented" title={MODES.find((m) => m.v === mode)?.help}>
              {MODES.map((m) => <button key={m.v} className={mode === m.v ? 'on' : ''} title={m.help} onClick={() => setMode(m.v)}>{m.label}</button>)}
            </div>
          )}
          {usage && usage.window ? <span className="small muted" title="Context used">{Math.round((usage.total / usage.window) * 100)}% context</span> : null}
          <button className="tb-btn" title="Open this chat in Codex's terminal interface" onClick={() => launch('terminal', { serverId: hostId, forceNew: true, props: { cwd: thread?.cwd || folder || home, command: thread ? `${codexPath} resume ${thread.id}` : codexPath } })}><SquareTerminal size={14} /></button>
        </div>

        <div
          className="codex-log scroll"
          ref={scroller}
          onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60 }}
        >
          {loadingThread && <div className="empty"><Spinner size={18} /></div>}
          {!loadingThread && !thread && entries.length === 0 && (
            <div className="codex-welcome">
              <div className="codex-welcome-icon">&gt;_</div>
              <h2>What should Codex do?</h2>
              <div className="muted small" style={{ maxWidth: 440, lineHeight: 1.6 }}>
                Codex works in <span className="mono">{short(folder || home, home)}</span> on the server. It can read and edit files there and run commands. {MODES.find((m) => m.v === mode)?.help}
              </div>
              <div className="codex-suggest">
                {['Explain what this folder contains', 'Find and fix a bug in this project', 'Write a README for this project', 'Check the server for problems (disk, memory, failed services)'].map((s) => (
                  <button key={s} className="btn" onClick={() => setText(s)}>{s}</button>
                ))}
              </div>
            </div>
          )}
          {entries.map((e) => <EntryView key={e.key} e={e} home={home} />)}
          {visiblePending.map((p) => <ApprovalCard key={String(p.id)} p={p} entries={entries} onAnswer={answer} />)}
          {running && visiblePending.length === 0 && <div className="codex-working"><Spinner size={12} /> Working…</div>}
        </div>

        <div className="codex-composer">
          <textarea
            className="input"
            rows={Math.min(8, Math.max(2, text.split('\n').length))}
            placeholder={running ? 'Codex is working… you can stop it with ■' : 'Ask Codex to do anything  (Enter to send, Shift+Enter for a new line)'}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send() } }}
          />
          <div className="row" style={{ gap: 6 }}>
            {models.length > 0 && (
              <select className="select" style={{ width: 150, height: 26 }} value={model} onChange={(e) => { setModel(e.target.value); setEffort('') }} title="Model">
                <option value="">Default model</option>
                {models.map((m) => <option key={m.model} value={m.model}>{m.displayName}</option>)}
              </select>
            )}
            {curModel && curModel.efforts.length > 1 && (
              <select className="select" style={{ width: 110, height: 26 }} value={effort} onChange={(e) => setEffort(e.target.value)} title="Reasoning effort">
                <option value="">Effort: {curModel.defaultEffort}</option>
                {curModel.efforts.map((x) => <option key={x} value={x}>{x}</option>)}
              </select>
            )}
            <div className="grow" />
            {running ? (
              <button className="btn codex-send" title="Stop" onClick={stop}><Square size={12} fill="currentColor" /></button>
            ) : (
              <button className="btn primary codex-send" title="Send" disabled={!text.trim()} onClick={send}><ArrowUp size={15} /></button>
            )}
          </div>
        </div>
      </section>
    </div>
  )
}

// ---------------------------------------------------------------------------
// transcript

function EntryView({ e, home }: { e: Entry; home: string }) {
  if (e.kind === 'error') return <div className="codex-error"><X size={13} /> {e.text}</div>
  if (e.kind === 'plan') {
    return (
      <div className="codex-card">
        <div className="codex-card-head"><ListChecks size={13} /> Plan</div>
        {e.explanation && <div className="small muted" style={{ marginBottom: 6 }}>{e.explanation}</div>}
        {e.plan.map((s, i) => (
          <div key={i} className="small" style={{ display: 'flex', gap: 6, padding: '2px 0', color: s.status === 'completed' ? 'var(--text-3)' : undefined, textDecoration: s.status === 'completed' ? 'line-through' : undefined }}>
            <span>{s.status === 'completed' ? '✓' : s.status === 'inProgress' ? '▸' : '○'}</span>{s.step}
          </div>
        ))}
      </div>
    )
  }
  const it = e.item
  switch (it.type) {
    case 'userMessage': {
      const t = (it.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n')
      return <div className="codex-user">{t}</div>
    }
    case 'agentMessage':
      return it.text ? <div className="codex-agent"><Markdown text={it.text} /></div> : null
    case 'reasoning': {
      const s = (it.summary ?? []).filter(Boolean).join('\n\n')
      return s ? <Collapsible icon={<Brain size={12} />} title="Thinking" muted><div className="small" style={{ whiteSpace: 'pre-wrap', lineHeight: 1.5 }}><Markdown text={s} /></div></Collapsible> : null
    }
    case 'commandExecution':
      return <CommandCard it={it} home={home} />
    case 'fileChange':
      return <FileChangeCard it={it} home={home} />
    case 'webSearch':
      return <div className="codex-tool"><Wrench size={12} /> Searched the web{it.query ? `: ${it.query}` : ''}</div>
    case 'mcpToolCall':
    case 'dynamicToolCall':
      return <div className="codex-tool"><Wrench size={12} /> {it.server ? `${it.server}: ` : ''}{it.tool ?? it.name ?? 'Tool'} {it.status === 'failed' ? '(failed)' : ''}</div>
    case 'contextCompaction':
      return <div className="codex-tool">Conversation summarized to save space</div>
    case 'plan':
      return it.text ? <div className="codex-card"><div className="codex-card-head"><ListChecks size={13} /> Plan</div><Markdown text={it.text} /></div> : null
    default:
      return null
  }
}

function CommandCard({ it, home }: { it: any; home: string }) {
  const cmd = String(it.command ?? '').replace(/^\/bin\/(?:ba)?sh -lc (['"])([\s\S]*)\1$/, '$2')
  const st = it.status
  const icon = st === 'inProgress' ? <Spinner size={11} /> : st === 'completed' && (it.exitCode ?? 0) === 0 ? <Check size={12} color="var(--green)" /> : <X size={12} color="var(--red)" />
  const label = st === 'declined' ? 'Not allowed' : st === 'failed' || (it.exitCode ?? 0) !== 0 ? `Exit ${it.exitCode ?? '?'}` : ''
  return (
    <Collapsible
      icon={icon}
      title={<span className="mono" style={{ fontSize: 11.5 }}>{cmd}</span>}
      right={<span className="small muted">{label}{it.durationMs ? ` ${(it.durationMs / 1000).toFixed(1)} s` : ''}</span>}
      open={st === 'inProgress'}
    >
      {it.cwd && <div className="small muted mono" style={{ marginBottom: 4 }}>in {short(String(it.cwd), home)}</div>}
      <pre className="codex-pre">{it.aggregatedOutput || (st === 'inProgress' ? '…' : '(no output)')}</pre>
    </Collapsible>
  )
}

function FileChangeCard({ it, home }: { it: any; home: string }) {
  const changes: any[] = it.changes ?? []
  const st = it.status
  return (
    <div className="codex-card">
      <div className="codex-card-head">
        <FileCode2 size={13} />
        {st === 'declined' ? 'Changes not applied' : st === 'inProgress' ? 'Editing files' : st === 'failed' ? 'Edit failed' : `Edited ${changes.length} file${changes.length === 1 ? '' : 's'}`}
      </div>
      {changes.map((c, i) => (
        <Collapsible key={i} title={<span className="mono" style={{ fontSize: 11.5 }}>{c.kind?.type === 'add' ? '+ ' : c.kind?.type === 'delete' ? '− ' : ''}{short(c.path, home)}</span>} right={<DiffStat diff={c.diff} />} open={changes.length <= 2}>
          <Diff text={c.diff} />
        </Collapsible>
      ))}
    </div>
  )
}

function DiffStat({ diff }: { diff: string }) {
  const lines = String(diff ?? '').split('\n')
  const add = lines.filter((l) => l.startsWith('+') && !l.startsWith('+++')).length
  const del = lines.filter((l) => l.startsWith('-') && !l.startsWith('---')).length
  return <span className="small mono"><span style={{ color: 'var(--green)' }}>+{add}</span> <span style={{ color: 'var(--red)' }}>−{del}</span></span>
}

function Diff({ text }: { text: string }) {
  return (
    <pre className="codex-pre codex-diff">
      {String(text ?? '').split('\n').slice(0, 800).map((l, i) => (
        <div key={i} className={l.startsWith('+') && !l.startsWith('+++') ? 'add' : l.startsWith('-') && !l.startsWith('---') ? 'del' : l.startsWith('@@') ? 'hunk' : ''}>{l || ' '}</div>
      ))}
    </pre>
  )
}

function Collapsible({ icon, title, right, children, open: initial = false, muted }: { icon?: ReactNode; title: ReactNode; right?: ReactNode; children: ReactNode; open?: boolean; muted?: boolean }) {
  const [open, setOpen] = useState(initial)
  useEffect(() => { if (initial) setOpen(true) }, [initial])
  return (
    <div className={`codex-coll ${muted ? 'muted' : ''}`}>
      <div className="codex-coll-head" onClick={() => setOpen(!open)}>
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        {icon}
        <span className="grow" style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</span>
        {right}
      </div>
      {open && <div className="codex-coll-body">{children}</div>}
    </div>
  )
}

// ---------------------------------------------------------------------------
// approvals and questions

function ApprovalCard({ p, entries, onAnswer }: { p: Pending; entries: Entry[]; onAnswer: (p: Pending, r: any) => void }) {
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const prm = p.params ?? {}
  if (p.method === 'item/tool/requestUserInput') {
    const qs: any[] = prm.questions ?? []
    const done = qs.every((q) => (answers[q.id] ?? '').trim())
    return (
      <div className="codex-approval">
        <div className="codex-card-head"><ShieldAlert size={14} /> Codex has {qs.length === 1 ? 'a question' : 'questions'}</div>
        {qs.map((q) => (
          <div key={q.id} style={{ marginBottom: 10 }}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>{q.header || q.question}</div>
            {q.header && <div className="small muted" style={{ marginBottom: 6 }}>{q.question}</div>}
            {(q.options ?? []).length > 0 && (
              <div className="row" style={{ flexWrap: 'wrap', gap: 6, marginBottom: 6 }}>
                {q.options.map((o: any) => <button key={o.label} title={o.description} className={`btn ${answers[q.id] === o.label ? 'primary' : ''}`} onClick={() => setAnswers({ ...answers, [q.id]: o.label })}>{o.label}</button>)}
              </div>
            )}
            {(!(q.options ?? []).length || q.isOther) && <input className="input" type={q.isSecret ? 'password' : 'text'} style={{ width: '100%' }} placeholder="Your answer" value={answers[q.id] ?? ''} onChange={(e) => setAnswers({ ...answers, [q.id]: e.target.value })} />}
          </div>
        ))}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn primary" disabled={!done} onClick={() => onAnswer(p, { answers: Object.fromEntries(qs.map((q) => [q.id, { answers: [answers[q.id]] }])) })}>Send Answer</button>
        </div>
      </div>
    )
  }
  if (p.method === 'item/permissions/requestApproval') {
    const want = prm.permissions ?? {}
    return (
      <div className="codex-approval">
        <div className="codex-card-head"><ShieldAlert size={14} /> Codex asks for more access</div>
        {prm.reason && <div style={{ marginBottom: 6 }}>{prm.reason}</div>}
        <pre className="codex-pre">{JSON.stringify(want, null, 2)}</pre>
        <div className="row" style={{ justifyContent: 'flex-end', gap: 6 }}>
          <button className="btn" onClick={() => onAnswer(p, { permissions: {}, scope: 'turn' })}>Decline</button>
          <button className="btn" onClick={() => onAnswer(p, { permissions: clean(want), scope: 'session' })}>Allow for This Chat</button>
          <button className="btn primary" onClick={() => onAnswer(p, { permissions: clean(want), scope: 'turn' })}>Allow Once</button>
        </div>
      </div>
    )
  }
  const isCmd = p.method === 'item/commandExecution/requestApproval'
  const item = (entries.find((e) => e.kind === 'item' && e.item.id === prm.itemId) as any)?.item
  const cmd = String(prm.command ?? item?.command ?? '').replace(/^\/bin\/(?:ba)?sh -lc (['"])([\s\S]*)\1$/, '$2')
  return (
    <div className="codex-approval">
      <div className="codex-card-head"><ShieldAlert size={14} /> {isCmd ? 'Allow Codex to run this command?' : 'Allow Codex to change these files?'}</div>
      {prm.reason && <div className="small" style={{ marginBottom: 6 }}>{prm.reason}</div>}
      {isCmd && <pre className="codex-pre">{cmd}</pre>}
      {!isCmd && item?.changes && <div className="small mono" style={{ marginBottom: 6 }}>{item.changes.map((c: any) => c.path).join('\n')}</div>}
      {isCmd && prm.cwd && <div className="small muted mono">in {prm.cwd}</div>}
      <div className="row" style={{ justifyContent: 'flex-end', gap: 6, marginTop: 8 }}>
        <button className="btn" onClick={() => onAnswer(p, { decision: 'decline' })}>Decline</button>
        <button className="btn" title="Also allow similar requests for the rest of this chat" onClick={() => onAnswer(p, { decision: 'acceptForSession' })}>Always in This Chat</button>
        <button className="btn primary" onClick={() => onAnswer(p, { decision: 'accept' })}>Allow</button>
      </div>
    </div>
  )
}

const clean = (o: any) => Object.fromEntries(Object.entries(o ?? {}).filter(([, v]) => v != null))

// ---------------------------------------------------------------------------
// a small, safe Markdown renderer (no HTML injection)

function Markdown({ text }: { text: string }) {
  const blocks = useMemo(() => parseBlocks(text), [text])
  return <>{blocks}</>
}

function parseBlocks(src: string): ReactNode[] {
  const out: ReactNode[] = []
  const lines = src.replace(/\r/g, '').split('\n')
  let i = 0
  let k = 0
  while (i < lines.length) {
    const l = lines[i]
    const fence = l.match(/^\s*```(\S*)/)
    if (fence) {
      const body: string[] = []
      i++
      while (i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i++])
      i++
      out.push(<pre key={k++} className="codex-pre">{body.join('\n')}</pre>)
      continue
    }
    const h = l.match(/^(#{1,4})\s+(.*)/)
    if (h) { out.push(<div key={k++} style={{ fontWeight: 700, fontSize: h[1].length <= 2 ? 15 : 13.5, margin: '10px 0 4px' }}>{inline(h[2])}</div>); i++; continue }
    if (/^\s*([-*•]|\d+[.)])\s+/.test(l)) {
      const items: string[] = []
      const ordered = /^\s*\d/.test(l)
      while (i < lines.length && /^\s*([-*•]|\d+[.)])\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*([-*•]|\d+[.)])\s+/, ''))
      const Tag = ordered ? 'ol' : 'ul'
      out.push(<Tag key={k++} style={{ margin: '4px 0', paddingLeft: 20 }}>{items.map((t, j) => <li key={j} style={{ margin: '2px 0' }}>{inline(t)}</li>)}</Tag>)
      continue
    }
    if (!l.trim()) { i++; continue }
    const para: string[] = []
    while (i < lines.length && lines[i].trim() && !/^\s*```/.test(lines[i]) && !/^(#{1,4})\s/.test(lines[i]) && !/^\s*([-*•]|\d+[.)])\s+/.test(lines[i])) para.push(lines[i++])
    out.push(<p key={k++} style={{ margin: '4px 0 8px', lineHeight: 1.55 }}>{inline(para.join('\n'))}</p>)
  }
  return out
}

function inline(s: string): ReactNode[] {
  const out: ReactNode[] = []
  const re = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/g
  let last = 0
  let m: RegExpExecArray | null
  let k = 0
  while ((m = re.exec(s))) {
    if (m.index > last) out.push(s.slice(last, m.index))
    const t = m[0]
    if (t.startsWith('`')) out.push(<code key={k++} className="codex-code">{t.slice(1, -1)}</code>)
    else if (t.startsWith('**')) out.push(<b key={k++}>{t.slice(2, -2)}</b>)
    else {
      // links are shown as text (label + target); nothing is opened automatically
      const mm = t.match(/^\[([^\]]+)\]\(([^)]+)\)$/)!
      out.push(<span key={k++} title={mm[2]} style={{ textDecoration: 'underline dotted' }}>{mm[1]}</span>)
    }
    last = m.index + t.length
  }
  if (last < s.length) out.push(s.slice(last))
  return out
}
