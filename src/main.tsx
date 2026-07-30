import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

// Ask the browser to make IndexedDB/cache eviction less likely. This is a
// best-effort durability hint; cloud sync and JSON backups remain essential.
if (navigator.storage?.persist) {
  void navigator.storage.persist().catch(() => {
    // Some browsers do not grant persistent storage or require more engagement.
  })
}

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    const entryFile = new URL(import.meta.url).pathname.split('/').at(-1)
    const parameters = new URLSearchParams({
      app: entryFile || 'app',
      sw: import.meta.env.VITE_SW_BUILD_ID,
    })
    const workerUrl =
      `${import.meta.env.BASE_URL}sw.js?${parameters.toString()}`
    void navigator.serviceWorker
      .register(workerUrl, {
        scope: import.meta.env.BASE_URL,
        updateViaCache: 'none',
      })
      .then((registration) => {
        window.setInterval(
          () => void registration.update(),
          60 * 60 * 1_000,
        )
      })
      .catch(() => {
        // The app still works online if service-worker storage is unavailable.
      })
  })
}
