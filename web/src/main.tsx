import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles/tokens.css'
import './styles/global.css'
import './styles/components.css'
import './styles/pages.css'
import './styles/pages/channels.css'
import './styles/pages/stats.css'
import './styles/pages/logs.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
