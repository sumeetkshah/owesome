// Remembers, per device, which groups you've opened and which member you are in each.
// Storage can be unavailable (private mode, blocked site data), so every access is guarded.

export interface SavedGroup {
  code: string
  name: string
  emoji: string
  memberId: string | null
  lastOpened: number
}

const KEY = 'owesome:groups'
const LEGACY_KEY = 'splitsmart:groups' // pre-rename; migrated on first read

export function savedGroups(): SavedGroup[] {
  try {
    const legacy = localStorage.getItem(LEGACY_KEY)
    if (legacy && !localStorage.getItem(KEY)) localStorage.setItem(KEY, legacy)
    if (legacy) localStorage.removeItem(LEGACY_KEY)
    const list = JSON.parse(localStorage.getItem(KEY) ?? '[]') as SavedGroup[]
    return list.sort((a, b) => b.lastOpened - a.lastOpened)
  } catch {
    return []
  }
}

export function getSaved(code: string): SavedGroup | undefined {
  return savedGroups().find((g) => g.code === code)
}

export function saveGroup(entry: Omit<SavedGroup, 'lastOpened'>) {
  try {
    const rest = savedGroups().filter((g) => g.code !== entry.code)
    localStorage.setItem(KEY, JSON.stringify([{ ...entry, lastOpened: Date.now() }, ...rest]))
  } catch {
    // Not persisted; the app still works for this session.
  }
}

export function forgetGroup(code: string) {
  try {
    localStorage.setItem(KEY, JSON.stringify(savedGroups().filter((g) => g.code !== code)))
  } catch {
    // ignore
  }
}
