import { useEffect, useState } from 'react'
import { Download, ExternalLink, PenLine } from 'lucide-react'
import type { FileEntry } from '../../../shared/types'
import { api } from '../lib/api'
import { Win } from '../lib/store'
import { category, ext, formatBytes, formatDate, isTextual, kindLabel, mimeFor } from '../lib/files'
import { FileIcon, Spinner } from '../components/ui'
import { openInEditor } from '../lib/actions'

export function QuickLook({ win }: { win: Win }) {
  const entry: FileEntry = win.props.entry
  const serverId = win.serverId!
  const [content, setContent] = useState<{ kind: 'text' | 'image' | 'pdf' | 'video' | 'audio' | 'none'; data?: string } | null>(null)
  const [err, setErr] = useState('')
  const cat = category(entry)

  useEffect(() => {
    setContent(null)
    setErr('')
    let cancel = false
    ;(async () => {
      try {
        if (['image', 'pdf', 'video', 'audio'].includes(cat) && entry.size < 25 * 1024 * 1024) {
          const data = await api.fs.readDataUrl(serverId, entry.path, mimeFor(entry.name))
          if (!cancel) setContent({ kind: cat as any, data })
        } else if ((isTextual(entry) || (cat === 'binary' && entry.size < 512 * 1024)) && entry.type !== 'dir') {
          const t = await api.fs.readText(serverId, entry.path)
          if (cancel) return
          if (t.slice(0, 4000).includes('\u0000')) setContent({ kind: 'none' })
          else setContent({ kind: 'text', data: t.length > 400000 ? t.slice(0, 400000) + '\n…' : t })
        } else setContent({ kind: 'none' })
      } catch (e: any) {
        if (!cancel) setErr(e.message)
      }
    })()
    return () => {
      cancel = true
    }
  }, [entry.path, serverId]) // eslint-disable-line

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div className="ql-body">
        {err ? (
          <div className="empty">{err}</div>
        ) : !content ? (
          <Spinner size={24} />
        ) : content.kind === 'image' ? (
          <img src={content.data} alt={entry.name} style={ext(entry.name) === 'svg' ? { background: '#fff' } : undefined} />
        ) : content.kind === 'pdf' ? (
          <iframe src={content.data} style={{ width: '100%', height: '100%', border: 0 }} title={entry.name} />
        ) : content.kind === 'video' ? (
          <video src={content.data} controls autoPlay style={{ maxWidth: '100%', maxHeight: '100%' }} />
        ) : content.kind === 'audio' ? (
          <audio src={content.data} controls autoPlay />
        ) : content.kind === 'text' ? (
          <pre>{content.data}</pre>
        ) : (
          <div className="col" style={{ alignItems: 'center', gap: 6 }}>
            <FileIcon cat={cat} size={128} label={ext(entry.name)} />
            <b style={{ fontSize: 15 }}>{entry.name}</b>
            <div className="muted">{kindLabel(entry)} — {formatBytes(entry.size)}</div>
            <div className="muted small">Modified {formatDate(entry.modified)}</div>
          </div>
        )}
      </div>
      <div className="row" style={{ padding: 8, borderTop: '1px solid var(--border)', justifyContent: 'flex-end' }}>
        <span className="grow small muted">{entry.path}</span>
        {content?.kind === 'text' && (
          <button className="btn" onClick={() => openInEditor(serverId, entry.path)}><PenLine size={12} /> Edit</button>
        )}
        <button className="btn" onClick={() => api.fs.openLocally(serverId, entry.path)}><ExternalLink size={12} /> Open with Mac App</button>
        <button className="btn" onClick={() => api.fs.download(serverId, [{ path: entry.path, isDir: false }])}><Download size={12} /> Download</button>
      </div>
    </div>
  )
}
