import type { Category } from './api'

export interface CategoryOption {
  key: string
  name: string
  emoji: string
}

export const PRESET_CATEGORIES: CategoryOption[] = [
  { key: 'food', name: 'Food & drinks', emoji: '🍽️' },
  { key: 'stay', name: 'Stay', emoji: '🏨' },
  { key: 'travel', name: 'Flights & trains', emoji: '✈️' },
  { key: 'transport', name: 'Cabs & local', emoji: '🚕' },
  { key: 'fuel', name: 'Fuel', emoji: '⛽' },
  { key: 'groceries', name: 'Groceries', emoji: '🛒' },
  { key: 'shopping', name: 'Shopping', emoji: '🛍️' },
  { key: 'activities', name: 'Activities', emoji: '🎟️' },
  { key: 'other', name: 'Other', emoji: '📦' },
]

export const customKey = (c: Category) => `custom:${c.id}`

export function allCategories(custom: Category[]): CategoryOption[] {
  return [...PRESET_CATEGORIES, ...custom.map((c) => ({ key: customKey(c), name: c.name, emoji: c.emoji }))]
}

export function findCategory(key: string, custom: Category[]): CategoryOption {
  return (
    allCategories(custom).find((c) => c.key === key) ?? { key, name: 'Other', emoji: '📦' }
  )
}
