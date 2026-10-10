import type { Expense, Settlement } from './api'

// All arithmetic is done in integer minor units (paise/cents) to avoid float drift.
export const toMinor = (n: number) => Math.round(n * 100)
export const fromMinor = (m: number) => m / 100

/** Split `total` minor units in proportion to `weights`, handing leftover units to the largest remainders. */
export function allocate(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0)
  if (sum <= 0) return weights.map(() => 0)
  const raw = weights.map((w) => (total * w) / sum)
  const out = raw.map(Math.floor)
  let left = total - out.reduce((a, b) => a + b, 0)
  const order = raw
    .map((r, i) => ({ frac: r - out[i], i, w: weights[i] }))
    .filter((x) => x.w > 0)
    .sort((a, b) => b.frac - a.frac)
  for (let k = 0; left > 0 && order.length; k++, left--) out[order[k % order.length].i]++
  return out
}

const formatters = new Map<string, Intl.NumberFormat>()

export function formatMoney(amount: number, currency: string, opts: { decimals?: boolean } = {}) {
  const decimals = opts.decimals ?? !Number.isInteger(Math.round(amount * 100) / 100)
  const key = `${currency}:${decimals}`
  let f = formatters.get(key)
  if (!f) {
    f = new Intl.NumberFormat(currency === 'INR' ? 'en-IN' : 'en-US', {
      style: 'currency',
      currency,
      minimumFractionDigits: decimals ? 2 : 0,
      maximumFractionDigits: decimals ? 2 : 0,
    })
    formatters.set(key, f)
  }
  return f.format(amount)
}

export function currencySymbol(currency: string) {
  const parts = new Intl.NumberFormat(currency === 'INR' ? 'en-IN' : 'en-US', {
    style: 'currency',
    currency,
  }).formatToParts(0)
  return parts.find((p) => p.type === 'currency')?.value ?? currency
}

/** Net position per member in minor units: positive = is owed money, negative = owes money. */
export function netBalances(memberIds: string[], expenses: Expense[], settlements: Settlement[]) {
  const net = new Map<string, number>(memberIds.map((id) => [id, 0]))
  const add = (id: string, v: number) => net.set(id, (net.get(id) ?? 0) + v)
  for (const e of expenses) {
    for (const p of e.payers) add(p.member_id, toMinor(p.amount))
    for (const s of e.splits) add(s.member_id, -toMinor(s.amount))
  }
  for (const s of settlements) {
    add(s.from_member, toMinor(s.amount))
    add(s.to_member, -toMinor(s.amount))
  }
  return net
}

export interface Transfer {
  from: string
  to: string
  amount: number // minor units
}

/** Greedy debt simplification: repeatedly match the largest debtor with the largest creditor. */
export function simplifyDebts(net: Map<string, number>): Transfer[] {
  const debtors = [...net].filter(([, v]) => v < 0).map(([id, v]) => ({ id, v: -v }))
  const creditors = [...net].filter(([, v]) => v > 0).map(([id, v]) => ({ id, v }))
  const transfers: Transfer[] = []
  while (debtors.length && creditors.length) {
    debtors.sort((a, b) => b.v - a.v)
    creditors.sort((a, b) => b.v - a.v)
    const d = debtors[0]
    const c = creditors[0]
    const amt = Math.min(d.v, c.v)
    if (amt > 0) transfers.push({ from: d.id, to: c.id, amount: amt })
    d.v -= amt
    c.v -= amt
    if (d.v === 0) debtors.shift()
    if (c.v === 0) creditors.shift()
  }
  return transfers
}

/** What a member paid and what their share was across all expenses, in minor units. */
export function memberTotals(memberId: string, expenses: Expense[]) {
  let paid = 0
  let share = 0
  for (const e of expenses) {
    for (const p of e.payers) if (p.member_id === memberId) paid += toMinor(p.amount)
    for (const s of e.splits) if (s.member_id === memberId) share += toMinor(s.amount)
  }
  return { paid, share }
}

export const CURRENCIES = ['INR', 'USD', 'EUR', 'GBP', 'AED', 'SGD', 'THB', 'JPY', 'AUD', 'CAD', 'IDR', 'LKR', 'MYR', 'CHF']
