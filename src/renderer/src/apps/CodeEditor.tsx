import { useEffect, useRef, useState } from 'react'
import { EditorView, basicSetup } from 'codemirror'
import { keymap } from '@codemirror/view'
import { Compartment, EditorState, Extension } from '@codemirror/state'
import { indentWithTab } from '@codemirror/commands'
import { StreamLanguage } from '@codemirror/language'
import { oneDark } from '@codemirror/theme-one-dark'
import { javascript } from '@codemirror/lang-javascript'
import { python } from '@codemirror/lang-python'
import { json } from '@codemirror/lang-json'
import { html } from '@codemirror/lang-html'
import { css } from '@codemirror/lang-css'
import { markdown } from '@codemirror/lang-markdown'
import { yaml } from '@codemirror/lang-yaml'
import { xml } from '@codemirror/lang-xml'
import { sql } from '@codemirror/lang-sql'
import { php } from '@codemirror/lang-php'
import { rust } from '@codemirror/lang-rust'
import { cpp } from '@codemirror/lang-cpp'
import { go } from '@codemirror/lang-go'
import { shell } from '@codemirror/legacy-modes/mode/shell'
import { nginx } from '@codemirror/legacy-modes/mode/nginx'
import { properties } from '@codemirror/legacy-modes/mode/properties'
import { dockerFile } from '@codemirror/legacy-modes/mode/dockerfile'
import { toml } from '@codemirror/legacy-modes/mode/toml'
import { FileText, FolderOpen, Save, X } from 'lucide-react'
import { api, uid } from '../lib/api'
import { confirm, prompt, toast, updateWindow, useStore, Win } from '../lib/store'
import { useCloseGuard, useWinAction } from '../components/Window'
import { baseName, ext, parentPath } from '../lib/files'
import { fsChanged } from '../lib/actions'
import { Spinner } from '../components/ui'

function langFor(path: string): Extension {
  const name = baseName(path).toLowerCase()
  const x = ext(name)
  if (name === 'dockerfile') return StreamLanguage.define(dockerFile)
  if (path.includes('nginx') && (x === 'conf' || !x)) return StreamLanguage.define(nginx)
  switch (x) {
    case 'js': case 'mjs': case 'cjs': case 'jsx': return javascript({ jsx: true })
    case 'ts': case 'tsx': return javascript({ jsx: true, typescript: true })
    case 'py': return python()
    case 'json': return json()
    case 'html': case 'htm': case 'vue': case 'svelte': return html()
    case 'css': case 'scss': case 'less': return css()
    case 'md': return markdown()
    case 'yml': case 'yaml': return yaml()
    case 'xml': case 'svg': return xml()
    case 'sql': return sql()
    case 'php': return php()
    case 'rs': return rust()
    case 'c': case 'h': case 'cpp': case 'hpp': case 'cc': return cpp()
    case 'go': return go()
    case 'toml': return StreamLanguage.define(toml)
    case 'ini': case 'conf': case 'cfg': case 'env': case 'properties': case 'service': return StreamLanguage.define(properties)
    case 'sh': case 'bash': case 'zsh': return StreamLanguage.define(shell)
  }
  if (/^\.(bashrc|profile|zshrc|bash_profile|bash_aliases)$/.test(name)) return StreamLanguage.define(shell)
  return []
}

interface Doc {
  id: string
  path: string
  loading: boolean
  error?: string
  dirty: boolean
  saved: string
  state?: EditorState
}

const lightTheme = EditorView.theme({
  '&': { backgroundColor: 'var(--win-bg)' },
  '.cm-gutters': { backgroundColor: 'var(--win-bg-2)', borderRight: '1px solid var(--border)', color: 'var(--text-3)' },
  '.cm-activeLine': { backgroundColor: 'rgba(0,122,255,.06)' },
  '.cm-activeLineGutter': { backgroundColor: 'rgba(0,122,255,.1)' },
})

export function CodeEditor({ win }: { win: Win }) {
  const serverId = win.serverId!
  const server = useStore((s) => s.servers.find((x) => x.id === serverId))
  const [docs, setDocs] = useState<Doc[]>([])
  const [active, setActive] = useState<string | null>(null)
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const themeComp = useRef(new Compartment())
  const docsRef = useRef(docs)
  docsRef.current = docs
  const activeRef = useRef(active)
  activeRef.current = active
  const [dark, setDark] = useState(document.documentElement.classList.contains('dark'))
  const [cursor, setCursor] = useState({ line: 1, col: 1 })

  useEffect(() => {
    const o = new MutationObserver(() => setDark(document.documentElement.classList.contains('dark')))
    o.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => o.disconnect()
  }, [])

  const save = async (id = activeRef.current) => {
    const d = docsRef.current.find((x) => x.id === id)
    if (!d || !view.current) return false
    const text = id === activeRef.current ? view.current.state.doc.toString() : d.state?.doc.toString() ?? ''
    try {
      await api.fs.writeText(serverId, d.path, text)
      setDocs((ds) => ds.map((x) => (x.id === id ? { ...x, dirty: false, saved: text } : x)))
      fsChanged(serverId, parentPath(d.path))
      return true
    } catch (e: any) {
      toast({ title: `Couldn't save ${baseName(d.path)}`, body: e.message, kind: 'error' })
      return false
    }
  }

  const makeState = (text: string, path: string) =>
    EditorState.create({
      doc: text,
      extensions: [
        basicSetup,
        keymap.of([
          indentWithTab,
          { key: 'Mod-s', preventDefault: true, run: () => { save(); return true } },
        ]),
        langFor(path),
        themeComp.current.of(dark ? oneDark : lightTheme),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) {
            const id = activeRef.current
            const cur = u.state.doc.toString()
            setDocs((ds) => ds.map((x) => (x.id === id ? { ...x, dirty: cur !== x.saved } : x)))
          }
          if (u.selectionSet || u.docChanged) {
            const pos = u.state.selection.main.head
            const line = u.state.doc.lineAt(pos)
            setCursor({ line: line.number, col: pos - line.from + 1 })
          }
        }),
      ],
    })

  const openFile = async (path: string) => {
    const existing = docsRef.current.find((d) => d.path === path)
    if (existing) return switchTo(existing.id)
    const id = uid()
    setDocs((ds) => [...ds, { id, path, loading: true, dirty: false, saved: '' }])
    stashActive()
    setActive(id)
    try {
      const text = await api.fs.readText(serverId, path).catch((e) => {
        if (/No such file/i.test(e.message)) return ''
        throw e
      })
      if (text.includes('\u0000')) throw new Error('This looks like a binary file.')
      const state = makeState(text, path)
      setDocs((ds) => ds.map((d) => (d.id === id ? { ...d, loading: false, saved: text, state } : d)))
      if (activeRef.current === id) view.current?.setState(state)
    } catch (e: any) {
      setDocs((ds) => ds.map((d) => (d.id === id ? { ...d, loading: false, error: e.message } : d)))
    }
  }

  const stashActive = () => {
    const cur = activeRef.current
    if (cur && view.current) {
      const st = view.current.state
      setDocs((ds) => ds.map((d) => (d.id === cur ? { ...d, state: st } : d)))
    }
  }

  const switchTo = (id: string) => {
    if (id === activeRef.current) return
    stashActive()
    setActive(id)
  }

  // mount editor view
  useEffect(() => {
    view.current = new EditorView({ parent: host.current!, state: EditorState.create({ doc: '' }) })
    return () => view.current?.destroy()
  }, [])

  // swap state on active change
  useEffect(() => {
    const d = docs.find((x) => x.id === active)
    if (d?.state && view.current && view.current.state !== d.state) {
      view.current.setState(d.state)
      view.current.dispatch({ effects: themeComp.current.reconfigure(dark ? oneDark : lightTheme) })
      view.current.focus()
    }
  }, [active]) // eslint-disable-line

  useEffect(() => {
    view.current?.dispatch({ effects: themeComp.current.reconfigure(dark ? oneDark : lightTheme) })
  }, [dark])

  // open requests from Finder
  useEffect(() => {
    const r = win.props.openRequest
    if (r?.path) openFile(r.path)
  }, [win.props.openRequest?.nonce]) // eslint-disable-line

  const closeDoc = async (id: string) => {
    const d = docsRef.current.find((x) => x.id === id)
    if (!d) return
    if (d.dirty) {
      const r = await confirm(`Do you want to save the changes you made to “${baseName(d.path)}”?`, 'Your changes will be lost if you don’t save them.', 'Save')
      if (r) {
        if (id !== activeRef.current) switchTo(id)
        if (!(await save(id))) return
      }
    }
    const rest = docsRef.current.filter((x) => x.id !== id)
    setDocs(rest)
    if (activeRef.current === id) {
      const next = rest[rest.length - 1]
      setActive(next?.id ?? null)
      if (!next) view.current?.setState(EditorState.create({ doc: '' }))
    }
  }

  const anyDirty = docs.some((d) => d.dirty)
  useEffect(() => {
    updateWindow(win.id, { dirty: anyDirty })
  }, [anyDirty, win.id])

  const activeDoc = docs.find((d) => d.id === active)
  useEffect(() => {
    updateWindow(win.id, { title: activeDoc ? `${baseName(activeDoc.path)} — ${server?.name ?? ''}` : `Code Editor — ${server?.name ?? ''}` })
  }, [activeDoc?.path, server?.name]) // eslint-disable-line

  useCloseGuard(win.id, async () => {
    const dirty = docsRef.current.filter((d) => d.dirty)
    if (!dirty.length) return true
    return confirm(`You have ${dirty.length} unsaved file${dirty.length > 1 ? 's' : ''}.`, 'Close anyway and discard changes?', 'Discard', true)
  })

  const openPrompt = async () => {
    const p = await prompt('Open File', activeDoc ? parentPath(activeDoc.path) + '/' : '', 'Enter the full path of the file on the server', 'Open')
    if (p) openFile(p.trim())
  }

  useWinAction(win.id, (a) => {
    if (a === 'new-tab') openPrompt()
  })

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div className="editor-tabs">
        {docs.map((d) => (
          <div key={d.id} className={`editor-tab ${d.id === active ? 'on' : ''}`} onMouseDown={() => switchTo(d.id)} title={d.path}>
            <FileText size={12} />
            {baseName(d.path)}
            {d.dirty ? (
              <button className="x" onMouseDown={(e) => e.stopPropagation()} onClick={() => closeDoc(d.id)}><span className="dirty" /></button>
            ) : (
              <button className="x" onMouseDown={(e) => e.stopPropagation()} onClick={() => closeDoc(d.id)}><X size={11} /></button>
            )}
          </div>
        ))}
        <div className="grow" />
        <button className="tb-btn" title="Open file (⌘T)" onClick={openPrompt} style={{ height: 30, borderRadius: 0 }}>
          <FolderOpen size={14} />
        </button>
        <button className="tb-btn" title="Save (⌘S)" disabled={!activeDoc?.dirty} onClick={() => save()} style={{ height: 30, borderRadius: 0 }}>
          <Save size={14} />
        </button>
      </div>
      <div className="cm-host" style={{ position: 'relative' }}>
        <div ref={host} style={{ height: '100%', display: activeDoc?.state ? 'block' : 'none' }} />
        {!activeDoc && (
          <div className="empty" style={{ position: 'absolute', inset: 0 }}>
            <FileText size={40} strokeWidth={1.2} />
            <h3>No file open</h3>
            <div>Open files from Finder, or</div>
            <button className="btn" onClick={openPrompt}>Open by Path…</button>
          </div>
        )}
        {activeDoc?.loading && <div className="empty" style={{ position: 'absolute', inset: 0 }}><Spinner size={22} /></div>}
        {activeDoc?.error && (
          <div className="empty" style={{ position: 'absolute', inset: 0 }}>
            <h3>Couldn’t open {baseName(activeDoc.path)}</h3>
            <div>{activeDoc.error}</div>
          </div>
        )}
      </div>
      <div className="statusbar" style={{ justifyContent: 'space-between', padding: '0 10px' }}>
        <span className="mono" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{activeDoc?.path ?? ''}</span>
        {activeDoc?.state && <span>Ln {cursor.line}, Col {cursor.col} · {ext(activeDoc.path).toUpperCase() || 'Plain Text'}</span>}
      </div>
    </div>
  )
}
