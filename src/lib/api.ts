import { supabase } from './supabase'

export type SplitType = 'equal' | 'exact' | 'percent' | 'shares' | 'itemized'
export type ExpenseKind = 'expense' | 'refund'

export interface Group {
  name: string
  emoji: string
  currency: string
  invite_code: string
  /** Storage folder for this group's receipts; deliberately unrelated to the invite code. */
  receipt_folder: string
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
  /** In the expense's own currency when it differs from the group's. */
  original_amount?: number | null
}

export interface Split {
  member_id: string
  amount: number
  weight: number | null
}

export interface ItemLine {
  name: string
  amount: number
  members: string[]
}

/** Editor state saved with an expense so it can be reopened exactly as entered. */
export interface ExpenseMeta {
  items?: ItemLine[]
  tax_pct?: number
  service_pct?: number
  tip?: number
  discount?: number
}

export interface Expense {
  id: string
  kind: ExpenseKind
  description: string
  amount: number
  category: string
  split_type: SplitType
  spent_on: string
  notes: string | null
  created_by: string | null
  created_at: string
  currency: string | null
  fx_rate: number
  original_amount: number | null
  meta: ExpenseMeta | null
  receipts: string[]
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

export type ActivityAction =
  | 'group.created'
  | 'group.updated'
  | 'member.joined'
  | 'member.renamed'
  | 'expense.added'
  | 'expense.updated'
  | 'expense.deleted'
  | 'expense.restored'
  | 'settlement.added'
  | 'settlement.deleted'
  | 'settlement.restored'

export interface ActivityEntry {
  id: string
  actor: string | null
  action: ActivityAction
  target_id: string | null
  details: {
    name?: string
    old_name?: string
    description?: string
    old_description?: string
    amount?: number
    old_amount?: number
    kind?: ExpenseKind
    from?: string
    to?: string
    reverted?: boolean
  }
  restored_at: string | null
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
  kind: ExpenseKind
  currency: string
  fx_rate: number
  original_amount: number
  meta?: ExpenseMeta
  receipts: string[]
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
      fx_rate: Number(e.fx_rate),
      original_amount: e.original_amount == null ? null : Number(e.original_amount),
      payers: e.payers.map((p) => ({
        ...p,
        amount: Number(p.amount),
        original_amount: p.original_amount == null ? null : Number(p.original_amount),
      })),
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
  // `actor` is the member this device is using, recorded in the group's activity log.
  updateMember: (code: string, id: string, name: string, actor: string) =>
    rpc<Member>('update_member', { p_code: code, p_id: id, p_name: name, p_actor: actor }),
  updateGroup: (code: string, name: string, emoji: string, actor: string) =>
    rpc<void>('update_group', { p_code: code, p_name: name, p_emoji: emoji, p_actor: actor }),
  addCategory: (code: string, name: string, emoji: string) =>
    rpc<Category>('add_category', { p_code: code, p_name: name, p_emoji: emoji }),
  saveExpense: (code: string, expense: ExpenseInput, actor: string) =>
    rpc<string>('save_expense', { p_code: code, p_expense: expense, p_actor: actor }),
  deleteExpense: (code: string, id: string, actor: string) =>
    rpc<void>('delete_expense', { p_code: code, p_id: id, p_actor: actor }),
  addSettlement: (code: string, from: string, to: string, amount: number, paidOn: string, actor: string, note?: string) =>
    rpc<string>('add_settlement', {
      p_code: code,
      p_from: from,
      p_to: to,
      p_amount: amount,
      p_paid_on: paidOn,
      p_note: note ?? null,
      p_actor: actor,
    }),
  deleteSettlement: (code: string, id: string, actor: string) =>
    rpc<void>('delete_settlement', { p_code: code, p_id: id, p_actor: actor }),
  getActivity: async (code: string) =>
    (await rpc<ActivityEntry[]>('get_activity', { p_code: code })).map((a) => ({
      ...a,
      details: {
        ...a.details,
        amount: a.details.amount == null ? undefined : Number(a.details.amount),
        old_amount: a.details.old_amount == null ? undefined : Number(a.details.old_amount),
      },
    })),
  restoreActivity: (code: string, id: string, actor: string) =>
    rpc<void>('restore_activity', { p_code: code, p_id: id, p_actor: actor }),
}
