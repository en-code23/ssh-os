import { useState } from 'react'
import { Image, Monitor, Palette, Server, SquareTerminal, FolderOpen, Keyboard } from 'lucide-react'
import { updateSettings, useStore, Win } from '../lib/store'
import { isMac, kbd } from '../lib/api'
import { Segmented, Switch, AppIcon } from '../components/ui'
import { launch } from './launch'

const WALLPAPERS = ['sonoma', 'ventura', 'monterey', 'aurora', 'graphite', 'sunrise']
const ACCENTS = ['#0a84ff', '#bf5af2', '#ff375f', '#ff453a', '#ff9f0a', '#ffd60a', '#30d158', '#8e8e93']

type Pane = 'appearance' | 'wallpaper' | 'dock' | 'finder' | 'terminal' | 'shortcuts'

const PANES: { id: Pane; label: string; icon: any; bg: string }[] = [
  { id: 'appearance', label: 'Appearance', icon: Palette, bg: 'linear-gradient(180deg,#3a3a3c,#1c1c1e)' },
  { id: 'wallpaper', label: 'Wallpaper', icon: Image, bg: 'linear-gradient(180deg,#64d2ff,#0a84ff)' },
  { id: 'dock', label: 'Desktop & Dock', icon: Monitor, bg: 'linear-gradient(180deg,#3a3a3c,#1c1c1e)' },
  { id: 'finder', label: 'Finder', icon: FolderOpen, bg: 'linear-gradient(180deg,#5ac8fa,#007aff)' },
  { id: 'terminal', label: 'Terminal', icon: SquareTerminal, bg: 'linear-gradient(180deg,#48484a,#1c1c1e)' },
  { id: 'shortcuts', label: 'Keyboard', icon: Keyboard, bg: 'linear-gradient(180deg,#a1a1a6,#636366)' },
]

export function SettingsApp({ win }: { win: Win }) {
  const s = useStore((st) => st.settings)
  const [pane, setPane] = useState<Pane>(win.props.pane ?? 'appearance')

  return (
    <div className="split">
      <div className="sidebar" style={{ width: 200 }}>
        {PANES.map((p) => (
          <div key={p.id} className={`sb-item ${pane === p.id ? 'active' : ''}`} onClick={() => setPane(p.id)}>
            <AppIcon icon={p.icon} bg={p.bg} size={20} />
            <span className="grow">{p.label}</span>
          </div>
        ))}
        <div className="sb-item" onClick={() => launch('servers')}>
          <AppIcon icon={Server} bg="linear-gradient(180deg,#34d399,#059669)" size={20} />
          <span className="grow">Servers…</span>
        </div>
      </div>
      <div className="grow scroll pad" style={{ background: 'var(--win-bg)' }}>
        <h2 style={{ margin: '0 0 16px', fontSize: 17 }}>{PANES.find((p) => p.id === pane)?.label}</h2>
        {pane === 'appearance' && (
          <div className="group-box">
            <div className="group-row">
              <span>Appearance</span>
              <Segmented
                value={s.appearance}
                onChange={(v) => updateSettings({ appearance: v })}
                options={[
                  { value: 'auto', label: 'Auto' },
                  { value: 'light', label: 'Light' },
                  { value: 'dark', label: 'Dark' },
                ]}
              />
            </div>
            <div className="group-row">
              <span>Accent color</span>
              <div className="row">
                {ACCENTS.map((c) => (
                  <button key={c} className={`color-swatch ${s.accent === c ? 'on' : ''}`} style={{ background: c }} onClick={() => updateSettings({ accent: c })} />
                ))}
              </div>
            </div>
          </div>
        )}
        {pane === 'wallpaper' && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, 120px)', gap: 14 }}>
            {WALLPAPERS.map((w) => (
              <div key={w} className="col" style={{ alignItems: 'center', gap: 4 }}>
                <button className={`wp-thumb wp-${w} ${s.wallpaper === w ? 'on' : ''}`} onClick={() => updateSettings({ wallpaper: w })} />
                <span className="small">{w[0].toUpperCase() + w.slice(1)}</span>
              </div>
            ))}
          </div>
        )}
        {pane === 'dock' && (
          <div className="group-box">
            <div className="group-row">
              <span>Size</span>
              <input type="range" min={36} max={80} value={s.dockSize} onChange={(e) => updateSettings({ dockSize: +e.target.value })} style={{ width: 200 }} />
            </div>
            <div className="group-row">
              <span>Magnification</span>
              <Switch on={s.dockMagnify} onChange={(v) => updateSettings({ dockMagnify: v })} />
            </div>
          </div>
        )}
        {pane === 'dock' && (
          <div className="group-box" style={{ marginTop: 14 }}>
            <div className="group-row">
              <span>Minecraft Servers app in the Dock</span>
              <Segmented
                value={s.showMinecraft}
                onChange={(v) => updateSettings({ showMinecraft: v })}
                options={[
                  { value: 'auto', label: 'When detected' },
                  { value: 'always', label: 'Always' },
                  { value: 'never', label: 'Never' },
                ]}
              />
            </div>
          </div>
        )}
        {pane === 'finder' && (
          <div className="group-box">
            <div className="group-row">
              <span>Show hidden files (dotfiles)</span>
              <Switch on={s.showHiddenFiles} onChange={(v) => updateSettings({ showHiddenFiles: v })} />
            </div>
          </div>
        )}
        {pane === 'terminal' && (
          <div className="group-box">
            <div className="group-row">
              <span>Font size</span>
              <div className="row">
                <input type="range" min={10} max={22} value={s.terminalFontSize} onChange={(e) => updateSettings({ terminalFontSize: +e.target.value })} style={{ width: 160 }} />
                <span className="muted" style={{ width: 30 }}>{s.terminalFontSize}pt</span>
              </div>
            </div>
            <div className="group-row">
              <span>Theme</span>
              <select className="select" style={{ width: 160 }} value={s.terminalTheme} onChange={(e) => updateSettings({ terminalTheme: e.target.value as any })}>
                <option value="auto">Match Appearance</option>
                <option value="dark">Pro (Dark)</option>
                <option value="light">Basic (Light)</option>
                <option value="ocean">Ocean</option>
                <option value="solarized">Solarized</option>
              </select>
            </div>
          </div>
        )}
        {pane === 'shortcuts' && <ShortcutList />}
      </div>
    </div>
  )
}

export function ShortcutList() {
  const rows: [string, string][] = [
    ['Spotlight', '⇧⌘Space'],
    ['Connect to Server', isMac ? '⌘K' : '⌥⌘K'],
    ['New Finder Window', isMac ? '⌘N' : '⌥⌘N'],
    ['New Terminal', isMac ? '⇧⌘T' : '⌥⌘T'],
    ['New Tab', isMac ? '⌘T' : '⇧⌘T'],
    ['Close Window', isMac ? '⌘W' : '⇧⌘W'],
    ...(isMac ? [['Minimize', '⌘M'] as [string, string]] : []),
    ['Cycle Windows', '⌘`'],
    ['Settings', '⌘,'],
    ['Finder: Quick Look', 'Space'],
    ['Finder: Rename', '↩'],
    ['Finder: Open', '⌘O / ⌘↓'],
    ['Finder: Enclosing Folder', '⌘↑'],
    ['Finder: Back / Forward', '⌘[ / ⌘]'],
    ['Finder: New Folder', '⇧⌘N'],
    ['Finder: Get Info', '⌘I'],
    ['Finder: Duplicate', '⌘D'],
    ['Finder: Copy / Cut / Paste', '⌘C / ⌘X / ⌘V'],
    ['Finder: Delete', '⌘⌫'],
    ['Finder: Icons / List / Columns', '⌘1 / ⌘2 / ⌘3'],
    ['Finder: Go to Folder', '⇧⌘G'],
    ['Show Hidden Files', '⇧⌘.'],
    ['Editor: Save', '⌘S'],
    ['Editor: Find', '⌘F'],
  ]
  return (
    <div className="group-box">
      {rows.map(([a, b]) => (
        <div key={a} className="group-row" style={{ minHeight: 32 }}>
          <span>{a}</span>
          <span className="kbd">{kbd(b)}</span>
        </div>
      ))}
    </div>
  )
}
