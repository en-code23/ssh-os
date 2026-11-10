import { createContext, ReactNode, useContext, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { CheckCircle2, CircleHelp, X, XCircle } from 'lucide-react'
import { api, uid } from '../../lib/api'
import { ServerConfig } from '../../../../shared/types'
import { McConfig, McServer, Schedule, saveConfig, sh } from '../../lib/mc/server'
import { Spinner } from '../../components/ui'

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g

export interface McCtx {
  srv: McServer
  host: ServerConfig
  reload: () => Promise<void>
  task: (title: string, script: string, opts?: { quiet?: boolean }) => Promise<{ code: number | null; output: string }>
  saveCfg: (patch: Partial<McConfig>) => Promise<void>
  setTab: (t: string) => void
}

export const Ctx = createContext<McCtx | null>(null)
export const useCtx = () => useContext(Ctx)!

// ---------------- Task runner (streams a script and shows its output) ----------------
interface TaskState {
  id: string
  title: string
  lines: string
  done: boolean
  code: number | null
  quiet?: boolean
}

export function useTaskRunner(hostId: string) {
  const [task, setTask] = useState<TaskState | null>(null)
  const run = (title: string, script: string, opts: { quiet?: boolean } = {}) =>
    new Promise<{ code: number | null; output: string }>((resolve) => {
      const id = uid()
      let out = ''
      setTask({ id, title, lines: '', done: false, code: null, quiet: opts.quiet })
      const off = api.on('stream:event', (e: { id: string; type: string; data?: string; code?: number | null }) => {
        if (e.id !== id) return
        if (e.type === 'data') {
          // collapse carriage-return progress bars
          out += (e.data ?? '').replace(ANSI, '')
          const shown = out.split('\n').map((l) => l.split('\r').filter(Boolean).pop() ?? '').join('\n')
          setTask((t) => (t && t.id === id ? { ...t, lines: shown.slice(-60000) } : t))
        } else {
          off()
          setTask((t) => (t && t.id === id ? { ...t, done: true, code: e.code ?? null } : t))
          if (opts.quiet && e.code === 0) setTimeout(() => setTask((t) => (t?.id === id ? null : t)), 600)
          resolve({ code: e.code ?? null, output: out })
        }
      })
      api.stream.start(hostId, id, sh(script)).catch((err) => {
        off()
        setTask((t) => (t && t.id === id ? { ...t, lines: String(err.message), done: true, code: 1 } : t))
        resolve({ code: 1, output: err.message })
      })
    })
  const el = task ? <TaskSheet task={task} onClose={() => setTask(null)} onStop={() => api.stream.stop(task.id)} /> : null
  return { run, el, busy: !!task && !task.done }
}

function TaskSheet({ task, onClose, onStop }: { task: TaskState; onClose: () => void; onStop: () => void }) {
  const ref = useRef<HTMLPreElement>(null)
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight
  }, [task.lines])
  return (
    <div className="modal-backdrop" style={{ position: 'absolute', paddingTop: 50, zIndex: 50 }}>
      <div className="sheet" style={{ width: 640, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div className="row">
          {!task.done ? <Spinner size={16} /> : task.code === 0 ? <CheckCircle2 size={18} color="var(--green)" /> : <XCircle size={18} color="var(--red)" />}
          <b className="grow">{task.title}</b>
          {task.done && <span className="small muted">{task.code === 0 ? 'Done' : `Failed (exit ${task.code ?? '?'})`}</span>}
        </div>
        <pre ref={ref} className="output card" style={{ margin: 0, height: 300, overflow: 'auto', fontSize: 11.5 }}>{task.lines || 'Working…'}</pre>
        <div className="sheet-actions" style={{ marginTop: 0 }}>
          {!task.done && <button className="btn" onClick={onStop}>Stop</button>}
          <button className="btn primary" disabled={!task.done} onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  )
}

// ---------------- Help popover ----------------
export function Help({ text, title }: { text: string; title?: string }) {
  const [open, setOpen] = useState<{ x: number; y: number } | null>(null)
  return (
    <>
      <button
        className="help-btn"
        title="Help"
        onClick={(e) => {
          e.stopPropagation()
          const r = e.currentTarget.getBoundingClientRect()
          setOpen(open ? null : { x: r.left, y: r.bottom + 6 })
        }}
      >
        <CircleHelp size={13} />
      </button>
      {open &&
        createPortal(
          <div className="popover-backdrop" onMouseDown={() => setOpen(null)}>
            <div className="popover" style={{ left: Math.min(open.x - 20, window.innerWidth - 340), top: Math.min(open.y, window.innerHeight - 200) }} onMouseDown={(e) => e.stopPropagation()}>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                {title && <b>{title}</b>}
                <button className="tb-btn" style={{ height: 20, minWidth: 20 }} onClick={() => setOpen(null)}><X size={12} /></button>
              </div>
              <div style={{ lineHeight: 1.5 }}>{text}</div>
            </div>
          </div>,
          document.body,
        )}
    </>
  )
}

// ---------------- Layout helpers ----------------
export function Row({ label, help, children, sub }: { label: ReactNode; help?: string; children: ReactNode; sub?: ReactNode }) {
  return (
    <div className="group-row">
      <div style={{ minWidth: 0 }}>
        <div className="row" style={{ gap: 4 }}>
          <span>{label}</span>
          {help && <Help text={help} title={typeof label === 'string' ? label : undefined} />}
        </div>
        {sub && <div className="small muted" style={{ marginTop: 2 }}>{sub}</div>}
      </div>
      <div className="row" style={{ flexShrink: 0 }}>{children}</div>
    </div>
  )
}

export function Section({ title, children, right, help }: { title: string; children: ReactNode; right?: ReactNode; help?: string }) {
  return (
    <div style={{ marginBottom: 18 }}>
      <div className="row" style={{ justifyContent: 'space-between', margin: '0 2px 6px' }}>
        <div className="row" style={{ gap: 4 }}>
          <b style={{ fontSize: 13 }}>{title}</b>
          {help && <Help text={help} title={title} />}
        </div>
        {right}
      </div>
      <div className="group-box">{children}</div>
    </div>
  )
}

export function ScheduleEditor({ value, onChange, allowHours = true }: { value: Schedule; onChange: (s: Schedule) => void; allowHours?: boolean }) {
  return (
    <div className="row">
      <select
        className="select"
        style={{ width: 120 }}
        value={value.kind}
        onChange={(e) => {
          const k = e.target.value as Schedule['kind']
          onChange(k === 'off' ? { kind: 'off' } : k === 'daily' ? { kind: 'daily', time: '04:00' } : k === 'weekly' ? { kind: 'weekly', day: 0, time: '04:00' } : { kind: 'hours', every: 6 })
        }}
      >
        <option value="off">Off</option>
        <option value="daily">Daily</option>
        <option value="weekly">Weekly</option>
        {allowHours && <option value="hours">Every N hours</option>}
      </select>
      {value.kind === 'weekly' && (
        <select className="select" style={{ width: 120 }} value={value.day} onChange={(e) => onChange({ ...value, day: +e.target.value })}>
          {['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map((d, i) => <option key={d} value={i}>{d}</option>)}
        </select>
      )}
      {(value.kind === 'daily' || value.kind === 'weekly') && (
        <input className="input" type="time" style={{ width: 96 }} value={value.time} onChange={(e) => onChange({ ...value, time: e.target.value })} />
      )}
      {value.kind === 'hours' && (
        <select className="select" style={{ width: 90 }} value={value.every} onChange={(e) => onChange({ kind: 'hours', every: +e.target.value })}>
          {[1, 2, 3, 4, 6, 8, 12].map((h) => <option key={h} value={h}>{h} h</option>)}
        </select>
      )}
    </div>
  )
}

export function StatusPill({ srv }: { srv: McServer }) {
  const label = srv.running ? (srv.external ? 'Running (external)' : 'Running') : 'Stopped'
  return (
    <span className="badge" style={{ background: srv.running ? 'color-mix(in srgb, var(--green) 20%, transparent)' : undefined, color: srv.running ? 'var(--green)' : undefined }}>
      {label}
    </span>
  )
}

export { saveConfig }
