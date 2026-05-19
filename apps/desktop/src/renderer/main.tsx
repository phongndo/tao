import { createRoot } from 'react-dom/client'
import { App } from './ui/App'
import 'react-mosaic-component/react-mosaic-component.css'
import '@xterm/xterm/css/xterm.css'
import './styles.css'

const rootElement = document.getElementById('root')

if (!rootElement) {
  throw new Error('Missing #root element')
}

createRoot(rootElement).render(<App />)
