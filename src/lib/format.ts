import type { Member } from './api'

export const MEMBER_COLORS = ['#d9b878', '#8fd3c1', '#f0a38a', '#a9b8f5', '#e8c3e6', '#b9dc8a', '#f3d27a', '#9cc9f0']

export const memberColor = (m: Pick<Member, 'color'>) => MEMBER_COLORS[m.color % MEMBER_COLORS.length]

export const today = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function formatDay(iso: string) {
  const d = new Date(iso + 'T00:00:00')
  const t = today()
  if (iso === t) return 'Today'
  const y = new Date(t + 'T00:00:00')
  y.setDate(y.getDate() - 1)
  if (d.getTime() === y.getTime()) return 'Yesterday'
  return d.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric',
  })
}
