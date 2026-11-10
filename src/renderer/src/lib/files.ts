import type { FileEntry } from '../../../shared/types'

export function formatBytes(n: number, zeroDash = false): string {
  if (!n) return zeroDash ? '--' : 'Zero bytes'
  if (n < 1000) return `${n} bytes`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n
  let i = -1
  do {
    v /= 1000
    i++
  } while (v >= 1000 && i < units.length - 1)
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`
}

export function formatDate(ms: number): string {
  if (!ms) return '--'
  const d = new Date(ms)
  const now = new Date()
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString()
  if (sameDay(d, now)) return `Today at ${time}`
  const y = new Date(now)
  y.setDate(now.getDate() - 1)
  if (sameDay(d, y)) return `Yesterday at ${time}`
  return d.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' }) + ` at ${time}`
}

export const isDirLike = (e: FileEntry) => e.type === 'dir' || (e.type === 'link' && !!e.linkToDir)

export function ext(name: string) {
  const i = name.lastIndexOf('.')
  return i > 0 ? name.slice(i + 1).toLowerCase() : ''
}

const IMAGE = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif']
const VIDEO = ['mp4', 'mov', 'mkv', 'avi', 'webm']
const AUDIO = ['mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac']
const ARCHIVE = ['zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'deb', 'rpm']
const CODE = ['js', 'jsx', 'ts', 'tsx', 'py', 'rb', 'go', 'rs', 'c', 'h', 'cpp', 'hpp', 'java', 'kt', 'php', 'swift', 'cs', 'lua', 'pl', 'vue', 'svelte']
const SCRIPT = ['sh', 'bash', 'zsh', 'fish']
const CONFIG = ['json', 'yaml', 'yml', 'toml', 'ini', 'conf', 'cfg', 'env', 'xml', 'service', 'properties']
const TEXT = ['txt', 'md', 'log', 'csv', 'rst', 'nfo']
const WEB = ['html', 'htm', 'css', 'scss', 'less']
const TEXT_NAMES = ['dockerfile', 'makefile', 'readme', 'license', 'hosts', 'fstab', 'crontab', 'authorized_keys', 'known_hosts', 'passwd', 'group', 'hostname', '.bashrc', '.profile', '.zshrc', '.gitignore', '.bash_history', '.vimrc', '.bash_logout', '.env']

export type FileCategory = 'folder' | 'image' | 'video' | 'audio' | 'archive' | 'code' | 'script' | 'config' | 'text' | 'web' | 'pdf' | 'binary' | 'link'

export function category(e: FileEntry): FileCategory {
  if (isDirLike(e)) return 'folder'
  const x = ext(e.name)
  if (IMAGE.includes(x)) return 'image'
  if (VIDEO.includes(x)) return 'video'
  if (AUDIO.includes(x)) return 'audio'
  if (ARCHIVE.includes(x)) return 'archive'
  if (x === 'pdf') return 'pdf'
  if (SCRIPT.includes(x)) return 'script'
  if (CODE.includes(x)) return 'code'
  if (WEB.includes(x)) return 'web'
  if (CONFIG.includes(x)) return 'config'
  if (TEXT.includes(x) || TEXT_NAMES.includes(e.name.toLowerCase())) return 'text'
  if (e.type === 'link') return 'link'
  if (!x || e.name.startsWith('.')) return 'text'
  return 'binary'
}

export function isTextual(e: FileEntry) {
  return ['code', 'script', 'config', 'text', 'web'].includes(category(e)) && e.size < 10 * 1024 * 1024
}

export function kindLabel(e: FileEntry): string {
  if (e.type === 'dir') return 'Folder'
  if (e.type === 'link') return e.linkToDir ? 'Alias (Folder)' : 'Alias'
  const x = ext(e.name)
  const map: Record<string, string> = {
    js: 'JavaScript', ts: 'TypeScript', tsx: 'TSX', jsx: 'JSX', py: 'Python Script', sh: 'Shell Script', md: 'Markdown',
    json: 'JSON', yml: 'YAML', yaml: 'YAML', html: 'HTML Document', css: 'CSS', txt: 'Plain Text', log: 'Log File',
    png: 'PNG Image', jpg: 'JPEG Image', jpeg: 'JPEG Image', gif: 'GIF Image', svg: 'SVG Image', pdf: 'PDF Document',
    zip: 'ZIP Archive', gz: 'GZip Archive', tar: 'Tar Archive', conf: 'Configuration', go: 'Go Source', rs: 'Rust Source',
    c: 'C Source', cpp: 'C++ Source', php: 'PHP Script', rb: 'Ruby Script', mp4: 'MPEG-4 Movie', mp3: 'MP3 Audio',
  }
  if (map[x]) return map[x]
  if (e.mode && e.mode & 0o111) return 'Unix Executable'
  return x ? `${x.toUpperCase()} File` : 'Document'
}

export function mimeFor(name: string) {
  const x = ext(name)
  const m: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
    svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon', avif: 'image/avif', pdf: 'application/pdf',
    mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg',
  }
  return m[x] ?? 'application/octet-stream'
}

export function parentPath(p: string) {
  if (p === '/' || !p) return '/'
  const parts = p.replace(/\/+$/, '').split('/')
  parts.pop()
  return parts.join('/') || '/'
}

export function joinPath(dir: string, name: string) {
  return dir === '/' ? `/${name}` : `${dir.replace(/\/+$/, '')}/${name}`
}

export function baseName(p: string) {
  if (p === '/') return '/'
  return p.replace(/\/+$/, '').split('/').pop() || '/'
}
