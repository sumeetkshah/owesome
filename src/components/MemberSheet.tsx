import { useState } from 'react'
import { api, type GroupData, type Member } from '../lib/api'
import { toast } from '../lib/toast'
import { Avatar, Sheet } from './ui'

interface Props {
  code: string
  data: GroupData
  me: string
  member: Member
  onClose: () => void
  onSaved: () => void
}

/** Rename someone, remove them if they're unused, or merge a duplicate into another member. */
export default function MemberSheet({ code, data, me, member, onClose, onSaved }: Props) {
  const others = data.members.filter((m) => m.id !== member.id)
  const [name, setName] = useState(member.name)
  const [into, setInto] = useState(others[0]?.id ?? '')
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  // Matches the server's rule: anyone on an expense or payment can only be merged, not removed.
  const involved =
    data.expenses.some(
      (e) => e.payers.some((p) => p.member_id === member.id) || e.splits.some((s) => s.member_id === member.id),
    ) || data.settlements.some((s) => s.from_member === member.id || s.to_member === member.id)
  const isMe = member.id === me
  const intoName = others.find((m) => m.id === into)?.name ?? ''

  const run = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true)
    setError('')
    try {
      await fn()
      toast(done)
      onSaved()
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }

  return (
    <Sheet title={isMe ? 'You' : member.name} onClose={onClose}>
      <div className="stack" style={{ gap: 20, marginTop: 8 }}>
        <div className="row">
          <Avatar member={{ ...member, name: name || member.name }} size="lg" />
          <span className="muted small">Changes here show up in the group’s History, and can be undone there.</span>
        </div>

        <label className="field">
          <span className="label">name</span>
          <div className="row">
            <input className="input" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
            <button
              className="btn btn-ghost"
              disabled={busy || !name.trim() || name.trim() === member.name}
              onClick={() => run(() => api.updateMember(code, member.id, name.trim(), me), 'Renamed')}
            >
              Save
            </button>
          </div>
        </label>

        <hr className="divider" />

        {others.length === 0 ? (
          <p className="faint small" style={{ margin: 0 }}>
            {isMe ? 'You’re' : `${member.name} is`} the only person in this group.
          </p>
        ) : involved ? (
          <div className="field">
            <span className="label">duplicate? merge into</span>
            <select
              className="select"
              value={into}
              onChange={(e) => {
                setInto(e.target.value)
                setConfirming(false)
              }}
            >
              {others.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.id === me ? `${m.name} (you)` : m.name}
                </option>
              ))}
            </select>
            <span className="faint small">
              Everything {member.name} paid, owes or settled moves to {intoName}, and {member.name} leaves the group.
              Balances stay exactly the same in total.
            </span>
            {confirming ? (
              <div className="row">
                <button
                  className="btn btn-danger grow"
                  disabled={busy}
                  onClick={() => run(() => api.mergeMember(code, member.id, into, me), 'Merged')}
                >
                  Yes, merge into {intoName}
                </button>
                <button className="btn btn-ghost" onClick={() => setConfirming(false)}>
                  Cancel
                </button>
              </div>
            ) : (
              <button className="btn btn-ghost btn-block" disabled={!into} onClick={() => setConfirming(true)}>
                Merge {member.name} into {intoName}
              </button>
            )}
          </div>
        ) : (
          <div className="field">
            <span className="label">remove</span>
            <span className="faint small">
              {member.name} isn’t on any expenses or payments, so they can be removed from the group.
            </span>
            {confirming ? (
              <div className="row">
                <button
                  className="btn btn-danger grow"
                  disabled={busy}
                  onClick={() => run(() => api.removeMember(code, member.id, me), 'Removed')}
                >
                  Yes, remove {isMe ? 'me' : member.name}
                </button>
                <button className="btn btn-ghost" onClick={() => setConfirming(false)}>
                  Cancel
                </button>
              </div>
            ) : (
              <button className="btn btn-danger btn-block" onClick={() => setConfirming(true)}>
                Remove {isMe ? 'me' : member.name} from the group
              </button>
            )}
          </div>
        )}

        {error && <div className="error-text">{error}</div>}
      </div>
    </Sheet>
  )
}
