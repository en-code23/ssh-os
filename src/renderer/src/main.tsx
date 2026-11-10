import { createRoot } from 'react-dom/client'
import '@xterm/xterm/css/xterm.css'
import './styles/global.css'
import { Desktop } from './components/Desktop'

createRoot(document.getElementById('root')!).render(<Desktop />)
