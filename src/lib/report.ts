import type { Expense, GroupData } from './api'
import { findCategory } from './categories'

export interface ReportFilter {
  from: string // yyyy-mm-dd or ''
  to: string
  memberId: string | null // only expenses this member shares in
}

export function filterExpenses(data: GroupData, f: ReportFilter): Expense[] {
  return data.expenses
    .filter((e) => (!f.from || e.spent_on >= f.from) && (!f.to || e.spent_on <= f.to))
    .filter((e) => !f.memberId || e.splits.some((s) => s.member_id === f.memberId))
    .sort((a, b) => a.spent_on.localeCompare(b.spent_on))
}

// Spreadsheets run cells starting with these as formulas, so a description like
// `=HYPERLINK("http://…")` would turn into a live link. Prefix them with ' to keep them as text,
// but leave plain numbers (refunds export as e.g. -250.00) alone.
const FORMULA_START = /^[=+\-@\t\r]/
const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/

const csvCell = (v: string | number | null | undefined) => {
  let s = v == null ? '' : String(v)
  if (FORMULA_START.test(s) && !PLAIN_NUMBER.test(s)) s = `'${s}`
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function expensesCsv(data: GroupData, expenses: Expense[]) {
  const cur = data.group.currency
  const name = (id: string) => data.members.find((m) => m.id === id)?.name ?? ''
  const header = [
    'Date',
    'Type',
    'Description',
    'Category',
    'Paid in',
    'Original amount',
    'FX rate',
    `Amount (${cur})`,
    'Paid by',
    'Split',
    ...data.members.map((m) => `${m.name} share (${cur})`),
    'Notes',
  ]
  const rows = expenses.map((e) => {
    const sign = e.kind === 'refund' ? -1 : 1
    return [
      e.spent_on,
      e.kind === 'refund' ? 'Refund' : 'Expense',
      e.description,
      findCategory(e.category, data.categories).name,
      e.currency ?? cur,
      (sign * (e.original_amount ?? e.amount)).toFixed(2),
      e.fx_rate,
      (sign * e.amount).toFixed(2),
      e.payers.map((p) => `${name(p.member_id)} ${p.amount.toFixed(2)}`).join('; '),
      e.split_type,
      ...data.members.map((m) => {
        const s = e.splits.find((x) => x.member_id === m.id)
        return s ? (sign * s.amount).toFixed(2) : ''
      }),
      e.notes ?? '',
    ]
  })
  return [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n')
}

export function download(filename: string, content: string, type = 'text/csv;charset=utf-8') {
  // BOM so Excel opens UTF-8 (₹, names with accents) correctly.
  const blob = new Blob(['﻿', content], { type })
  const url = URL.createObjectURL(blob)
  const a = Object.assign(document.createElement('a'), { href: url, download: filename })
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'group'
