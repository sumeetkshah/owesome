import { supabase } from './supabase'

export type SplitType = 'equal' | 'exact' | 'percent' | 'shares'

export interface Group {
  name: string
  emoji: string
  currency: string
  invite_code: string
  created_at: string
}

export interface Member {
  id: string
  name: string
  color: number
  created_at: string
}

export interface Category {
  id: string
  name: string
  emoji: string
}

export interface Payer {
  member_id: string
  amount: number
}

export interface Split {
  member_id: string
  amount: number
  weight: number | null
}

export interface Expense {
  id: string
  description: string
  amount: number
  category: string
  split_type: SplitType
  spent_on: string
  notes: string | null
  created_by: string | null
  created_at: string
  payers: Payer[]
  splits: Split[]
}

export interface Settlement {
  id: string
  from_member: string
  to_member: string
  amount: number
  paid_on: string
  note: string | null
  created_at: string
}

export interface GroupData {
  group: Group
  members: Member[]
  categories: Category[]
  expenses: Expense[]
  settlements: Settlement[]
}

export interface ExpenseInput {
  id?: string
  description: string
  amount: number
  category: string
  split_type: SplitType
  spent_on: string
  notes?: string
  created_by?: string
  payers: Payer[]
  splits: Split[]
}

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args)
  if (error) throw new Error(error.message)
  return data as T
}

// Postgres numerics arrive as numbers or strings depending on size; normalise.
function normalise(data: GroupData): GroupData {
  return {
    ...data,
    expenses: data.expenses.map((e) => ({
      ...e,
      amount: Number(e.amount),
      payers: e.payers.map((p) => ({ ...p, amount: Number(p.amount) })),
      splits: e.splits.map((s) => ({
        ...s,
        amount: Number(s.amount),
        weight: s.weight == null ? null : Number(s.weight),
      })),
    })),
    settlements: data.settlements.map((s) => ({ ...s, amount: Number(s.amount) })),
  }
}

export const api = {
  createGroup: (name: string, emoji: string, currency: string, creator: string, others: string[]) =>
    rpc<{ invite_code: string; member_id: string }>('create_group', {
      p_name: name,
      p_emoji: emoji,
      p_currency: currency,
      p_creator: creator,
      p_others: others,
    }),
  getGroup: async (code: string) => normalise(await rpc<GroupData>('get_group', { p_code: code })),
  addMember: (code: string, name: string) => rpc<Member>('add_member', { p_code: code, p_name: name }),
  updateGroup: (code: string, name: string, emoji: string) =>
    rpc<void>('update_group', { p_code: code, p_name: name, p_emoji: emoji }),
  addCategory: (code: string, name: string, emoji: string) =>
    rpc<Category>('add_category', { p_code: code, p_name: name, p_emoji: emoji }),
  saveExpense: (code: string, expense: ExpenseInput) =>
    rpc<string>('save_expense', { p_code: code, p_expense: expense }),
  deleteExpense: (code: string, id: string) => rpc<void>('delete_expense', { p_code: code, p_id: id }),
  addSettlement: (code: string, from: string, to: string, amount: number, paidOn: string, note?: string) =>
    rpc<string>('add_settlement', {
      p_code: code,
      p_from: from,
      p_to: to,
      p_amount: amount,
      p_paid_on: paidOn,
      p_note: note ?? null,
    }),
  deleteSettlement: (code: string, id: string) => rpc<void>('delete_settlement', { p_code: code, p_id: id }),
}
