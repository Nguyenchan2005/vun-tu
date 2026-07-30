import { Bell, Home, Library, Upload } from 'lucide-react'

import type { AppScreen } from '../navigation'

export interface MobileNavProps {
  currentScreen: AppScreen
  onNavigate: (screen: AppScreen) => void
}

const mobileNavigation: ReadonlyArray<{
  screen: AppScreen
  label: string
  icon: typeof Home
}> = [
  { screen: 'today', label: 'Hôm nay', icon: Home },
  { screen: 'decks', label: 'Bộ từ', icon: Library },
  { screen: 'import', label: 'Nhập từ', icon: Upload },
  { screen: 'reminders', label: 'Cài đặt', icon: Bell },
]

export function MobileNav({
  currentScreen,
  onNavigate,
}: MobileNavProps) {
  return (
    <nav
      className="mobile-navigation"
      aria-label="Điều hướng trên thiết bị di động"
      data-testid="mobile-nav"
    >
      {mobileNavigation.map((item) => {
        const Icon = item.icon
        const active = currentScreen === item.screen

        return (
          <button
            className={`mobile-navigation__item${
              item.screen === 'import'
                ? ' mobile-navigation__item--primary'
                : ''
            }${
              active ? ' is-active' : ''
            }`}
            type="button"
            key={item.screen}
            onClick={() => onNavigate(item.screen)}
            aria-current={active ? 'page' : undefined}
            data-testid={`mobile-nav-${item.screen}`}
          >
            <Icon aria-hidden="true" />
            <span>{item.label}</span>
          </button>
        )
      })}
    </nav>
  )
}
