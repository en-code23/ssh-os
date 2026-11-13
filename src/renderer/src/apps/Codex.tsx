import { useEffect, useState } from 'react'
import { Bot, Download, FolderOpen, KeyRound, LogIn, LogOut, Play, RefreshCw, Settings2, Trash2 } from 'lucide-react'
import { api, shq } from '../lib/api'
import { confirm, ensureConnected, toast, useStore, Win } from '../lib/store'
import { openInEditor } from '../lib/actions'
import { useMc } from '../lib/mc/store'
import { Segmented, Spinner } from '../components/ui'
import { Toolbar } from '../components/Window'
import { Row, Section, useTaskRunner } from './minecraft/common'
import { launch } from './launch'

const REPO = 'openai/codex'

interface Status {
  path: string
  version: string
  arch: string
  login: string
  git: boolean
  inPath: boolean
  home: string
}

const STATUS = `P=$(command -v codex 2>/dev/null); [ -z "$P" ] && [ -x "$HOME/.local/bin/codex" ] && P="$HOME/.local/bin/codex"
echo "$P"; echo '@@'
[ -n "$P" ] && "$P" --version 2>/dev/null | head -1; echo '@@'
uname -m; echo '@@'
[ -n "$P" ] && "$P" login status 2>&1 | head -2; echo '@@'
command -v git >/dev/null && echo yes; echo '@@'
case ":$PATH:" in *":$HOME/.local/bin:"*) echo yes;; esac; echo '@@'
echo "$HOME"`

/** Codex runs on the server: install it there and open it in a Terminal tab. */
export function Codex({ win }: { win: Win }) {
  const servers = useStore((s) => s.servers)
  const conns = useStore((s) => s.conns)
  const ssh = servers.filter((s) => s.protocol === 'ssh')
  const [hostId, setHostId] = useState<string | undefined>(() => win.serverId ?? win.props.serverId ?? ssh.find((s) => conns[s.id]?.status === 'connected')?.id ?? ssh[0]?.id)
  const connected = !!hostId && conns[hostId]?.status === 'connected'
  const [st, setSt] = useState<Status | null>(null)
  const [latest, setLatest] = useState<{ tag: string; assets: any[] } | null>(null)
  const [folder, setFolder] = useState(win.props.folder ?? '')
  const [mode, setMode] = useState<'default' | 'auto' | 'readonly'>('default')
  const [prompt, setPrompt] = useState('')
  const [apiKey, setApiKey] = useState('')
  const runner = useTaskRunner(hostId ?? '')
  const mcServers = useMc((s) => s.servers)
  const mcDirs = hostId ? (mcServers[hostId] ?? []).map((x) => x.dir) : []

  const refresh = async () => {
    if (!hostId || !connected) return
    setSt(null)
    const r = await api.exec(hostId, `sh -c ${shq(STATUS)}`)
    const [path, version, arch, login, git, inPath, home] = r.stdout.split('@@').map((x) => x.trim())
    setSt({ path, version, arch, login, git: git === 'yes', inPath: inPath === 'yes', home })
    if (!folder) setFolder(home)
  }

  useEffect(() => {
    if (hostId && !connected) ensureConnected(hostId)
  }, [hostId]) // eslint-disable-line
  useEffect(() => {
    refresh()
  }, [hostId, connected]) // eslint-disable-line
  useEffect(() => {
    api.httpJson(`https://api.github.com/repos/${REPO}/releases/latest`).then((r) => setLatest({ tag: r.tag_name, assets: r.assets ?? [] })).catch(() => {})
  }, [])

  const latestVersion = latest?.tag.replace(/^rust-v|^v/, '') ?? ''
  const installedVersion = st?.version.match(/(\d+\.\d+\.\d+)/)?.[1] ?? ''
  const installed = !!st?.path
  const upToDate = installed && latestVersion && installedVersion === latestVersion
  const loggedIn = !!st?.login && /logged in/i.test(st.login) && !/not logged in/i.test(st.login)
  const codex = st?.path || '$HOME/.local/bin/codex'

  const install = async () => {
    if (!hostId || !st || !latest) return
    const arch = /aarch64|arm64/.test(st.arch) ? 'aarch64' : /x86_64|amd64/.test(st.arch) ? 'x86_64' : ''
    if (!arch) return toast({ title: `Codex has no build for ${st.arch}`, body: 'Supported: x86_64 and arm64 (aarch64) Linux.', kind: 'error' })
    const name = `codex-${arch}-unknown-linux-musl`
    const asset = latest.assets.find((a) => a.name === `${name}.tar.gz`)
    if (!asset) return toast({ title: 'Download not found in the latest release', kind: 'error' })
    const sha = typeof asset.digest === 'string' && /^sha256:[a-f0-9]{64}$/.test(asset.digest) ? asset.digest.slice(7) : ''
    if (!sha) return toast({ title: 'The download has no checksum, so it was not installed', kind: 'error' })
    // installs into ~/.local/bin (no sudo); a system-wide codex elsewhere is left alone
    if (st.path && !st.path.includes('/.local/bin/') && !(await confirm('Codex is installed system-wide', `Found ${st.path}. SSH OS will install its own copy in ~/.local/bin instead, which takes priority for this user.`, 'Continue'))) return
    const script = `set -e
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
mkdir -p "$HOME/.local/bin"
echo "Downloading Codex ${latestVersion} (${arch})…"
if command -v curl >/dev/null; then curl -fL --progress-bar -o "$T/c.tgz" ${shq(asset.browser_download_url)}; else wget -q -O "$T/c.tgz" ${shq(asset.browser_download_url)}; fi
echo "${sha}  $T/c.tgz" | sha256sum -c - >/dev/null && echo "Checksum OK"
tar xzf "$T/c.tgz" -C "$T"
install -m 755 "$T/${name}" "$HOME/.local/bin/codex.new" && mv -f "$HOME/.local/bin/codex.new" "$HOME/.local/bin/codex"
for f in "$HOME/.profile" "$HOME/.bashrc"; do
  [ -f "$f" ] || [ "$f" = "$HOME/.profile" ] || continue
  grep -qs '.local/bin' "$f" || { printf '\\n# added by SSH OS for Codex\\nexport PATH="$HOME/.local/bin:$PATH"\\n' >> "$f"; echo "Added ~/.local/bin to PATH in $(basename "$f")"; }
done
"$HOME/.local/bin/codex" --version`
    const r = await runner.run(installed ? 'Updating Codex' : 'Installing Codex', script)
    if (r.code === 0) toast({ title: `Codex ${latestVersion} installed`, body: loggedIn ? undefined : 'Next: sign in with ChatGPT or an API key.', kind: 'success' })
    refresh()
  }

  const loginApiKey = async () => {
    if (!hostId || !st || !apiKey.trim()) return
    // the key goes through a private temp file (never on a command line or in shell history)
    const tmp = `${st.home}/.codex-key-${Math.random().toString(36).slice(2)}`
    try {
      await api.exec(hostId, `sh -c ${shq(`umask 077; : > ${shq(tmp)}`)}`)
      await api.fs.writeText(hostId, tmp, apiKey.trim())
      const r = await api.exec(hostId, `sh -c ${shq(`${codex} login --with-api-key < ${shq(tmp)} 2>&1; rc=$?; rm -f ${shq(tmp)}; exit $rc`)}`)
      if (r.code !== 0) throw new Error(r.stdout.trim() || 'Sign-in failed')
      setApiKey('')
      toast({ title: 'Signed in with API key', kind: 'success' })
    } catch (e: any) {
      await api.exec(hostId, `rm -f ${shq(tmp)}`).catch(() => {})
      toast({ title: 'Sign-in failed', body: e.message, kind: 'error' })
    }
    refresh()
  }

  const loginChatGPT = () => {
    if (!hostId) return
    // device-code flow works on a headless server: open the link on any device and enter the code
    launch('terminal', { serverId: hostId, forceNew: true, props: { command: `${codex} login --device-auth` } })
    toast({ title: 'Follow the steps in Terminal', body: 'Open the link it shows on your Mac, sign in, and enter the code. Then click Refresh here.' })
  }

  const logout = async () => {
    if (!hostId || !(await confirm('Sign out of Codex on this server?', undefined, 'Sign Out'))) return
    await api.exec(hostId, `sh -c ${shq(`${codex} logout`)}`)
    refresh()
  }

  const uninstall = async () => {
    if (!hostId || !(await confirm('Uninstall Codex?', 'Removes ~/.local/bin/codex. Your settings and sign-in in ~/.codex are kept.', 'Uninstall', true))) return
    await api.exec(hostId, `rm -f "$HOME/.local/bin/codex"`)
    refresh()
  }

  const open = () => {
    if (!hostId) return
    const flags = mode === 'auto' ? ' --full-auto' : mode === 'readonly' ? ' --sandbox read-only' : ''
    const cmd = `${codex}${flags}${prompt.trim() ? ' ' + shq(prompt.trim()) : ''}`
    launch('terminal', { serverId: hostId, forceNew: true, props: { cwd: folder || st?.home, command: cmd } })
  }

  const editConfig = async () => {
    if (!hostId || !st) return
    await api.exec(hostId, `mkdir -p "$HOME/.codex" && touch "$HOME/.codex/config.toml"`)
    openInEditor(hostId, `${st.home}/.codex/config.toml`)
  }

  return (
    <>
      <Toolbar>
        <div style={{ width: 84 }} />
        <div className="toolbar-title" style={{ flex: 1 }}>Codex</div>
        <select className="select" style={{ width: 200 }} value={hostId ?? ''} onChange={(e) => { setHostId(e.target.value); setSt(null); setFolder('') }}>
          {ssh.length === 0 && <option value="">No SSH servers</option>}
          {ssh.map((s) => <option key={s.id} value={s.id}>{conns[s.id]?.status === 'connected' ? '● ' : '○ '}{s.name}</option>)}
        </select>
        <button className="tb-btn" title="Refresh" onClick={refresh}><RefreshCw size={15} /></button>
      </Toolbar>
      <div className="grow scroll pad" style={{ maxWidth: 760, width: '100%', margin: '0 auto' }}>
        {!hostId ? (
          <div className="empty"><h3>Add an SSH server first</h3><button className="btn" onClick={() => launch('servers')}>Open Servers</button></div>
        ) : !connected || !st ? (
          <div className="empty"><Spinner size={22} /></div>
        ) : (
          <>
            <div className="row" style={{ gap: 14, marginBottom: 18 }}>
              <div className="server-avatar" style={{ width: 52, height: 52, borderRadius: 13, background: 'linear-gradient(135deg,#111,#3a3a3c)' }}><Bot size={26} /></div>
              <div className="grow">
                <div style={{ fontSize: 18, fontWeight: 700 }}>Codex on {servers.find((s) => s.id === hostId)?.name}</div>
                <div className="small muted">OpenAI’s coding agent, running on the server: it reads and edits files in a folder you choose and runs commands there.</div>
              </div>
            </div>

            <Section title="Installation">
              <Row label={installed ? `Codex ${installedVersion || st.version}` : 'Not installed'} sub={installed ? st.path : `Installs to ~/.local/bin/codex (no sudo). ${st.arch}`}>
                {installed && upToDate && <span className="badge" style={{ color: 'var(--green)' }}>Up to date</span>}
                {latestVersion && (!installed || !upToDate) && (
                  <button className="btn primary" disabled={runner.busy} onClick={install}><Download size={12} /> {installed ? `Update to ${latestVersion}` : `Install ${latestVersion}`}</button>
                )}
                {installed && st.path.includes('/.local/bin/') && <button className="tb-btn" title="Uninstall" onClick={uninstall}><Trash2 size={14} /></button>}
              </Row>
              {installed && !st.inPath && <div className="small muted" style={{ padding: '4px 0 8px' }}>~/.local/bin was added to your PATH for new shells; SSH OS calls Codex by its full path meanwhile.</div>}
              {!st.git && <div className="small" style={{ color: 'var(--orange)', padding: '4px 0 8px' }}>git isn’t installed. Codex works best inside a git repository so you can review and undo its changes (sudo apt install git).</div>}
            </Section>

            {installed && (
              <Section title="Account">
                <Row label={loggedIn ? 'Signed in' : 'Not signed in'} sub={st.login || undefined}>
                  {loggedIn ? <button className="btn" onClick={logout}><LogOut size={12} /> Sign Out</button> : <button className="btn primary" onClick={loginChatGPT}><LogIn size={12} /> Sign in with ChatGPT</button>}
                </Row>
                {!loggedIn && (
                  <Row label="Or use an API key" help="An OpenAI API key (sk-…). It is sent to the server over SSH and stored by Codex in ~/.codex; usage is billed to that key.">
                    <input className="input" type="password" placeholder="sk-…" style={{ width: 220 }} value={apiKey} onChange={(e) => setApiKey(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && loginApiKey()} />
                    <button className="btn" disabled={!apiKey.trim()} onClick={loginApiKey}><KeyRound size={12} /> Use Key</button>
                  </Row>
                )}
              </Section>
            )}

            {installed && (
              <Section title="Start Codex">
                <Row label="Folder" help="Codex works inside this folder: it can read and change files there. Use a git repository so you can review its changes.">
                  <input className="input mono" style={{ width: 300 }} value={folder} onChange={(e) => setFolder(e.target.value)} list="codex-folders" />
                  <datalist id="codex-folders">{[st.home, ...mcDirs].map((d) => <option key={d} value={d} />)}</datalist>
                  <button className="tb-btn" title="Open folder in Finder" onClick={() => launch('finder', { serverId: hostId, forceNew: true, props: { path: folder || st.home } })}><FolderOpen size={14} /></button>
                </Row>
                <Row label="Permissions" help="Default: Codex asks before running commands. Full auto: it can edit files in the folder and run commands without asking (sandboxed to the folder). Read only: it can look but not change anything.">
                  <Segmented value={mode} onChange={setMode} options={[{ value: 'default', label: 'Ask first' }, { value: 'auto', label: 'Full auto' }, { value: 'readonly', label: 'Read only' }]} />
                </Row>
                <Row label="First message (optional)">
                  <input className="input" style={{ width: 340 }} placeholder="e.g. Explain this project" value={prompt} onChange={(e) => setPrompt(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && open()} />
                </Row>
                <div className="row" style={{ justifyContent: 'flex-end', padding: '8px 0' }}>
                  <button className="btn" onClick={editConfig}><Settings2 size={12} /> Edit config.toml</button>
                  <button className="btn primary lg" onClick={open}><Play size={13} /> Open Codex</button>
                </div>
              </Section>
            )}
          </>
        )}
      </div>
      {runner.el}
    </>
  )
}
