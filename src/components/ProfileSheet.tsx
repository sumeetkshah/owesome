import { useState } from 'react'
import { api, type Member } from '../lib/api'
import { toast } from '../lib/toast'
import { Avatar, Sheet } from './ui'

interface Props {
  code: string
  member: Member
  onClose: () => void
  onSaved: () => void
}

export default function ProfileSheet({ code, member, onClose, onSaved }: Props) {
  const [name, setName] = useState(member.name)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const save = async () => {
    setBusy(true)
    setError('')
    try {
      await api.updateMember(code, member.id, name.trim(), member.id)
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

        {error && <div className="error-text">{error}</div>}

        <button className="btn btn-primary btn-block" onClick={save} disabled={busy || !name.trim() || name.trim() === member.name}>
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </Sheet>
  )
}
