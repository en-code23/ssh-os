import {
  Activity, Code2, Pickaxe, Eye, Info, Network, ScrollText, Server, Settings as Gear, Smile, SquareTerminal, Zap, Box,
  type LucideIcon,
} from 'lucide-react'
import type { AppId } from '../lib/store'

export interface AppMeta {
  id: AppId
  name: string
  icon: LucideIcon
  bg: string
  /** needs a connected server */
  needsServer?: boolean
  /** needs SSH (shell) rather than just file access */
  needsExec?: boolean
  /** Toolbar is drawn by the app inside the titlebar (Finder-style) */
  unified?: boolean
  inDock?: boolean
}

export const APPS: Record<AppId, AppMeta> = {
  finder: { id: 'finder', name: 'Finder', icon: Smile, bg: 'linear-gradient(135deg,#6ac8ff 0%,#1e8bf0 50%,#1565d8 100%)', needsServer: true, unified: true, inDock: true },
  terminal: { id: 'terminal', name: 'Terminal', icon: SquareTerminal, bg: 'linear-gradient(180deg,#3a3a3c,#111)', needsServer: true, needsExec: true, inDock: true },
  servers: { id: 'servers', name: 'Servers', icon: Server, bg: 'linear-gradient(180deg,#34d399,#059669)', unified: true, inDock: true },
  monitor: { id: 'monitor', name: 'Activity Monitor', icon: Activity, bg: 'linear-gradient(180deg,#2b2b2e,#0b0b0c)', needsServer: true, needsExec: true, unified: true, inDock: true },
  editor: { id: 'editor', name: 'Code Editor', icon: Code2, bg: 'linear-gradient(180deg,#5b8cff,#3949db)', needsServer: true, inDock: true },
  console: { id: 'console', name: 'Console', icon: ScrollText, bg: 'linear-gradient(180deg,#5e5e63,#2c2c2e)', needsServer: true, needsExec: true, unified: true, inDock: true },
  network: { id: 'network', name: 'Network Utility', icon: Network, bg: 'linear-gradient(180deg,#64d2ff,#0a84ff)', needsServer: true, needsExec: true, unified: true, inDock: true },
  shortcuts: { id: 'shortcuts', name: 'Shortcuts', icon: Zap, bg: 'linear-gradient(135deg,#ff6b9a,#a855f7 55%,#3b82f6)', unified: true, inDock: true },
  settings: { id: 'settings', name: 'System Settings', icon: Gear, bg: 'linear-gradient(180deg,#a1a1a6,#636366)', inDock: true },
  about: { id: 'about', name: 'About SSH OS', icon: Box, bg: 'linear-gradient(135deg,#0a84ff,#5e5ce6)' },
  quicklook: { id: 'quicklook', name: 'Quick Look', icon: Eye, bg: 'linear-gradient(180deg,#8e8e93,#48484a)' },
  minecraft: { id: 'minecraft', name: 'Minecraft Servers', icon: Pickaxe, bg: 'linear-gradient(180deg,#7cc34a 0%,#5a9a2e 45%,#8b5a2b 46%,#6b4423 100%)', needsServer: false, unified: true },
  info: { id: 'info', name: 'Get Info', icon: Info, bg: 'linear-gradient(180deg,#8e8e93,#48484a)' },
}

export const DOCK_ORDER: AppId[] = ['finder', 'terminal', 'servers', 'editor', 'monitor', 'console', 'network', 'shortcuts', 'settings']
