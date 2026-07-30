import type { Unsubscribe } from './types'

export interface NetworkMonitor {
  isOnline(): boolean
  subscribe(listener: (online: boolean) => void): Unsubscribe
}

export class BrowserNetworkMonitor implements NetworkMonitor {
  isOnline(): boolean {
    return typeof navigator === 'undefined' ||
      typeof navigator.onLine !== 'boolean'
      ? true
      : navigator.onLine
  }

  subscribe(listener: (online: boolean) => void): Unsubscribe {
    if (typeof window === 'undefined') {
      return () => undefined
    }
    const online = () => listener(true)
    const offline = () => listener(false)
    window.addEventListener('online', online)
    window.addEventListener('offline', offline)
    return () => {
      window.removeEventListener('online', online)
      window.removeEventListener('offline', offline)
    }
  }
}
