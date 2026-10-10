import { useState } from 'react'
import { api, type Member } from '../lib/api'
import { toast } from '../lib/toast'
import { UPI_PATTERN } from '../lib/upi'
import { Avatar, Sheet } from './ui'

interface Props {
  code: string
  member: Member
  onClose: () => void
  onSaved: () => void
}

export default function ProfileSheet({ code, member, onClose, onSaved }: Props) {
  const [name, setName] = useState(member.name)
  const [upi, setUpi] = useState(member.upi_id ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const upiOk = !upi.trim() || UPI_PATTERN.test(upi.trim())

  const save = async () => {
    setBusy(true)
    setError('')
    try {
      await api.updateMember(code, member.id, name.trim(), upi.trim())
      toast('Profile saved')
      onSaved()
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }

  return (
    <Sheet title="Your profile" onClose={onClose}>
      <div className="stack" style={{ gap: 20, marginTop: 8 }}>
        <div className="row">
          <Avatar member={{ ...member, name: name || member.name }} size="lg" />
          <span className="muted small">This is how you appear to everyone in this group.</span>
        </div>

        <label className="field">
          <span className="label">name</span>
          <input className="input" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
        </label>

        <label className="field">
          <span className="label">upi id (optional)</span>
          <input
            className="input"
            placeholder="yourname@okhdfcbank"
            value={upi}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            onChange={(e) => setUpi(e.target.value)}
          />
          <span className={upiOk ? 'faint small' : 'error-text'}>
            {upiOk
              ? 'Shown to group members so they can pay you in one tap. Only for INR groups.'
              : 'That doesn’t look like a UPI ID (e.g. name@bank).'}
          </span>
        </label>

        {error && <div className="error-text">{error}</div>}

        <button className="btn btn-primary btn-block" onClick={save} disabled={busy || !name.trim() || !upiOk}>
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </Sheet>
  )
}
