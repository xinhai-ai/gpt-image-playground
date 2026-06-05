import 'core-js/actual/array/at'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import 'streamdown/styles.css'
import './index.css'
import { installMobileViewportGuards } from './lib/viewport'

installMobileViewportGuards()

// Service worker 已移除。注销此前部署版本注册的 SW 并清理其缓存，
// 否则老客户端会继续用缓存的旧应用壳，无法获取更新。
if ('serviceWorker' in navigator) {
  void navigator.serviceWorker.getRegistrations().then((registrations) => {
    registrations.forEach((registration) => void registration.unregister())
  }).catch(() => {})
  if (typeof caches !== 'undefined') {
    void caches.keys().then((keys) => {
      keys
        .filter((key) => key.startsWith('gpt-image-playground'))
        .forEach((key) => void caches.delete(key))
    }).catch(() => {})
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
