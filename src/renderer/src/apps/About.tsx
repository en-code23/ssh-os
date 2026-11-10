import { useEffect, useState } from 'react'
import { Box } from 'lucide-react'
import { api } from '../lib/api'
import { useStore, Win } from '../lib/store'
import { AppIcon } from '../components/ui'
import { ShortcutList } from './Settings'

export function About({ win }: { win: Win }) {
  const [info, setInfo] = useState<{ version: string; electron: string } | null>(null)
  const servers = useStore((s) => s.servers.length)
  useEffect(() => {
    api.appInfo().then(setInfo)
  }, [])
  if (win.props.tab === 'shortcuts') return <div className="grow scroll pad"><ShortcutList /></div>
  return (
    <div className="col" style={{ alignItems: 'center', padding: 24, gap: 6, textAlign: 'center' }}>
      <AppIcon icon={Box} bg="linear-gradient(135deg,#0a84ff,#5e5ce6)" size={96} />
      <h2 style={{ margin: '12px 0 0', fontSize: 22 }}>SSH OS</h2>
      <div className="muted">Version {info?.version ?? '…'}</div>
      <div className="small muted" style={{ marginTop: 10, lineHeight: 1.6 }}>
        A macOS-style desktop for your servers.
        <br />
        SSH · SFTP · FTP · FTPS — {servers} server{servers === 1 ? '' : 's'} configured
      </div>
      <div className="small muted" style={{ marginTop: 10 }}>
        Based on{' '}
        <a href="#" onClick={(e) => { e.preventDefault(); api.openExternal('https://github.com/Mhyar-nsi/cube-ssh') }} style={{ color: 'var(--accent)' }}>
          cube-ssh
        </a>{' '}
        (MIT) · Electron {info?.electron}
      </div>
    </div>
  )
}
