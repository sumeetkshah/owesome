import { useCallback, useEffect, useState } from 'react'
import { api, type ActivityEntry, type GroupData } from '../lib/api'
import { formatDay } from '../lib/format'
import { formatMoney } from '../lib/money'
import { toast } from '../lib/toast'

const ICONS: Record<ActivityEntry['action'], string> = {
  'group.created': '✨',
  'group.updated': '✏️',
  'member.joined': '👋',
  'member.renamed': '✏️',
  'member.removed': '👋',
  'member.merged': '🔗',
  'member.restored': '↩️',
  'expense.added': '➕',
  'expense.updated': '✏️',
  'expense.deleted': '🗑️',
  'expense.restored': '↩️',
  'settlement.added': '🤝',
  'settlement.deleted': '🗑️',
  'settlement.restored': '↩️',
}

const UNDO_LABEL: Partial<Record<ActivityEntry['action'], string>> = {
  'expense.deleted': 'Restore',
  'expense.updated': 'Revert edit',
  'settlement.deleted': 'Restore',
  'member.removed': 'Restore',
  'member.merged': 'Undo merge',
}

const localDay = (iso: string) => {
  const d = new Date(iso)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const time = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })

export default function History({
  code,
  data,
  me,
  onRestored,
}: {
  code: string
  data: GroupData
  me: string
  onRestored: () => void
}) {
  const [entries, setEntries] = useState<ActivityEntry[] | null>(null)
  const [error, setError] = useState('')
  const [confirming, setConfirming] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const cur = data.group.currency

  const load = useCallback(async () => {
    try {
      setEntries(await api.getActivity(code))
      setError('')
    } catch (e) {
      setError((e as Error).message)
    }
  }, [code])

  useEffect(() => {
    load()
  }, [load, data])

  if (error && !entries) return <div className="empty">{error}</div>
  if (!entries) return <div className="spinner" aria-label="Loading" />
  if (entries.length === 0) {
    return (
      <div className="empty">
        <div className="emoji">🕰️</div>
        Changes to this group will show up here.
      </div>
    )
  }

  const everyone = [...data.members, ...data.formerMembers]
  const name = (id: string | null | undefined) =>
    id == null ? 'Someone' : id === me ? 'You' : (everyone.find((m) => m.id === id)?.name ?? 'Someone')
  const amt = (v: number | undefined) => (v == null ? '' : formatMoney(v, cur))

  const describe = (a: ActivityEntry) => {
    const d = a.details
    const what = `${d.kind === 'refund' ? 'refund ' : ''}“${d.description}”`
    switch (a.action) {
      case 'group.created':
        return `created the group`
      case 'group.updated':
        return d.old_name && d.old_name !== d.name ? `renamed the group from ${d.old_name} to ${d.name}` : 'updated the group'
      case 'member.joined':
        return `joined the group`
      case 'member.renamed':
        return `renamed ${d.old_name} to ${d.name}`
      case 'member.removed':
        return `removed ${d.name} from the group`
      case 'member.merged':
        return `merged ${d.name} into ${d.into_name}`
      case 'member.restored':
        return `brought ${d.name} back`
      case 'expense.added':
        return `added ${what} · ${amt(d.amount)}`
      case 'expense.updated': {
        const renamed = d.old_description && d.old_description !== d.description ? ` (was “${d.old_description}”)` : ''
        const repriced = d.old_amount != null && d.old_amount !== d.amount ? `${amt(d.old_amount)} → ${amt(d.amount)}` : amt(d.amount)
        return `edited ${what}${renamed} · ${repriced}`
      }
      case 'expense.deleted':
        return `deleted ${what} · ${amt(d.amount)}`
      case 'expense.restored':
        return d.reverted ? `reverted an edit to ${what} · ${amt(d.amount)}` : `restored ${what} · ${amt(d.amount)}`
      case 'settlement.added':
        return `recorded ${name(d.from)} paid ${name(d.to)} · ${amt(d.amount)}`
      case 'settlement.deleted':
        return `removed a payment from ${name(d.from)} to ${name(d.to)} · ${amt(d.amount)}`
      case 'settlement.restored':
        return `restored a payment from ${name(d.from)} to ${name(d.to)} · ${amt(d.amount)}`
    }
  }

  const undo = async (a: ActivityEntry) => {
    setBusy(true)
    try {
      await api.restoreActivity(code, a.id, me)
      toast(a.action === 'expense.updated' ? 'Edit reverted' : a.action === 'member.merged' ? 'Merge undone' : 'Restored')
      setConfirming(null)
      onRestored()
    } catch (e) {
      toast((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <p className="faint small" style={{ marginTop: 0 }}>
        Every change anyone makes. Deleted items can be restored and edits reverted.
      </p>
      {entries.map((a, i) => {
        const date = localDay(a.created_at)
        const sep = i === 0 || date !== localDay(entries[i - 1].created_at)
        const undoLabel = !a.restored_at ? UNDO_LABEL[a.action] : undefined
        return (
          <div key={a.id}>
            {sep && <div className="label date-sep">{formatDay(date)}</div>}
            <div className="list-item">
              <span className="emoji-tile">{ICONS[a.action]}</span>
              <span className="grow">
                <div className="title">
                  {name(a.actor)} <span style={{ fontWeight: 400 }}>{describe(a)}</span>
                </div>
                <div className="sub">
                  {time(a.created_at)}
                  {a.restored_at && ' · undone'}
                </div>
              </span>
              {undoLabel &&
                (confirming === a.id ? (
                  <span className="row" style={{ gap: 8 }}>
                    <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => undo(a)}>
                      {undoLabel}?
                    </button>
                    <button className="link" onClick={() => setConfirming(null)}>
                      Cancel
                    </button>
                  </span>
                ) : (
                  <button className="link" style={{ fontSize: 12 }} onClick={() => setConfirming(a.id)}>
                    {undoLabel}
                  </button>
                ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}
