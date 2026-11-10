import { ComponentType } from 'react'
import type { AppId, Win } from '../lib/store'
import { Finder } from './Finder'
import { Terminal } from './Terminal'
import { Servers } from './Servers'
import { ActivityMonitor } from './ActivityMonitor'
import { CodeEditor } from './CodeEditor'
import { Console } from './Console'
import { NetworkUtility } from './NetworkUtility'
import { Shortcuts } from './Shortcuts'
import { SettingsApp } from './Settings'
import { About } from './About'
import { QuickLook } from './QuickLook'
import { GetInfo } from './GetInfo'
import { Minecraft } from './minecraft/Minecraft'

export const COMPONENTS: Record<AppId, ComponentType<{ win: Win }>> = {
  finder: Finder,
  terminal: Terminal,
  servers: Servers,
  monitor: ActivityMonitor,
  editor: CodeEditor,
  console: Console,
  network: NetworkUtility,
  shortcuts: Shortcuts,
  settings: SettingsApp,
  about: About,
  quicklook: QuickLook,
  info: GetInfo,
  minecraft: Minecraft,
}
