import { useState } from 'react'
import { api, type GroupData } from '../lib/api'
import { currencySymbol, fromMinor, toMinor } from '../lib/money'
import { today } from '../lib/format'
import { toast } from '../lib/toast'
import { Avatar, Sheet } from './ui'

interface Props {
  code: string
  data: GroupData
  me: string
  initial?: { from: string; to: string; amount: number } // amount in minor units
  onClose: () => void
  onSaved: () => void
}

export default function SettleSheet({ code, data, me, initial, onClose, onSaved }: Props) {
  const { members, group } = data
  const [from, setFrom] = useState(initial?.from ?? me)
  const [to, setTo] = useState(initial?.to ?? members.find((m) => m.id !== me)?.id ?? '')
  const [amount, setAmount] = useState(initial ? String(fromMinor(initial.amount)) : '')
  const [paidOn, setPaidOn] = useState(today())
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const value = parseFloat(amount) || 0
  const name = (id: string) => (id === me ? 'You' : (members.find((m) => m.id === id)?.name ?? ''))
  const fromMember = members.find((m) => m.id === from)
  const toMember = members.find((m) => m.id === to)

  const save = async () => {
    setBusy(true)
    setError('')
    try {
      await api.addSettlement(code, from, to, fromMinor(toMinor(value)), paidOn, me, note.trim() || undefined)
      toast('Payment recorded')
      onSaved()
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }

  return (
    <Sheet title="Record a payment" onClose={onClose}>
      {fromMember && toMember && (
        <div className="row" style={{ justifyContent: 'center', gap: 14, padding: '14px 0 0' }}>
          <Avatar member={fromMember} size="lg" />
          <span className="faint" style={{ fontSize: 22 }}>
            →
          </span>
          <Avatar member={toMember} size="lg" />
        </div>
      )}

      <div className="amount-input">
        <span className="sym">{currencySymbol(group.currency)}</span>
        <input
          inputMode="decimal"
          placeholder="0"
          value={amount}
          aria-label="Amount"
          style={{ width: `${Math.max(amount.length, 1) + 0.6}ch` }}
          onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, '').replace(/(\..*?)\..*/, '$1'))}
        />
      </div>

      <div className="stack" style={{ gap: 18 }}>
        <div className="row">
          <div className="field grow">
            <span className="label">who paid</span>
            <select className="select" value={from} onChange={(e) => setFrom(e.target.value)}>
              {members.map((m) => (
                <option key={m.id} value={m.id}>
                  {name(m.id)}
                </option>
              ))}
            </select>
          </div>
          <div className="field grow">
            <span className="label">to</span>
            <select className="select" value={to} onChange={(e) => setTo(e.target.value)}>
              {members.map((m) => (
                <option key={m.id} value={m.id}>
                  {name(m.id)}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="field">
          <span className="label">date</span>
          <input className="input" type="date" value={paidOn} onChange={(e) => setPaidOn(e.target.value)} />
        </div>

        <input
          className="input"
          placeholder="Note (optional) — e.g. paid in cash"
          value={note}
          maxLength={200}
          onChange={(e) => setNote(e.target.value)}
        />

        {from === to && <div className="error-text">Pick two different people.</div>}
        {error && <div className="error-text">{error}</div>}

        <button
          className="btn btn-primary btn-block"
          onClick={save}
          disabled={busy || value <= 0 || from === to || !to}
        >
          {busy ? 'Saving…' : 'Record payment'}
        </button>
      </div>
    </Sheet>
  )
}
