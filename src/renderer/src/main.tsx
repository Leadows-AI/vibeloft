import './tauriBridge' // first: sets window.vibe when running in Tauri
import { createRoot } from 'react-dom/client'
import App from './App'
import '@fontsource-variable/inter'
import '@fontsource-variable/jetbrains-mono'
import './styles.css'

document.documentElement.dataset.platform = window.vibe.platform

createRoot(document.getElementById('root')!).render(<App />)
