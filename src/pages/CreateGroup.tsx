import { useState } from 'react'
import { Brand } from '../components/ui'
import { api } from '../lib/api'
import { saveGroup } from '../lib/identity'
import { CURRENCIES } from '../lib/money'
import { navigate } from '../lib/router'

const EMOJIS = ['✈️', '🏖️', '🏔️', '🚗', '🏠', '💼', '🍻', '🎉', '🏕️', '🌴']

export default function CreateGroup() {
  const [name, setName] = useState('')
  const [emoji, setEmoji] = useState(EMOJIS[0])
  const [currency, setCurrency] = useState('INR')
  const [you, setYou] = useState('')
  const [others, setOthers] = useState<string[]>([])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const addOther = () => {
    const n = draft.trim()
    if (!n) return
    const taken = [you, ...others].some((x) => x.trim().toLowerCase() === n.toLowerCase())
    if (!taken) setOthers([...others, n])
    setDraft('')
  }

  const submit = async () => {
    setBusy(true)
    setError('')
    try {
      const pending = draft.trim() ? [...others, draft.trim()] : others
      const res = await api.createGroup(name.trim(), emoji, currency, you.trim(), pending)
      saveGroup({ code: res.invite_code, name: name.trim(), emoji, memberId: res.member_id })
      navigate(`/g/${res.invite_code}?new=1`, true)
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }

  const valid = name.trim() && you.trim()

  return (
    <div className="app">
      <div className="topbar">
        <Brand onClick={() => navigate('/')} />
        <button className="icon-btn" onClick={() => history.back()} aria-label="Back">
          ←
        </button>
      </div>

      <h1 className="display h1" style={{ marginBottom: 6 }}>
        New <em>group.</em>
      </h1>
      <p className="muted" style={{ marginTop: 0 }}>
        You’ll get an invite link to share once it’s created.
      </p>

      <div className="stack" style={{ gap: 22, marginTop: 24 }}>
        <div className="field">
          <span className="label">what’s it for</span>
          <div className="row">
            <span className="emoji-tile lg">{emoji}</span>
            <input
              className="input"
              placeholder="Goa, Dec 2026"
              value={name}
              maxLength={60}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
          </div>
          <div className="chips">
            {EMOJIS.map((e) => (
              <button key={e} className={`chip ${e === emoji ? 'on' : ''}`} onClick={() => setEmoji(e)}>
                {e}
              </button>
            ))}
          </div>
        </div>

        <div className="field">
          <span className="label">currency</span>
          <select className="select" value={currency} onChange={(e) => setCurrency(e.target.value)}>
            {CURRENCIES.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </div>

        <div className="field">
          <span className="label">your name</span>
          <input
            className="input"
            placeholder="What should the group call you?"
            value={you}
            maxLength={40}
            onChange={(e) => setYou(e.target.value)}
          />
        </div>

        <div className="field">
          <span className="label">add people (optional)</span>
          <div className="row">
            <input
              className="input"
              placeholder="Their name"
              value={draft}
              maxLength={40}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addOther()}
            />
            <button className="btn btn-ghost" onClick={addOther} disabled={!draft.trim()}>
              Add
            </button>
          </div>
          {others.length > 0 && (
            <div className="chips">
              {others.map((o) => (
                <button key={o} className="chip on" onClick={() => setOthers(others.filter((x) => x !== o))}>
                  {o} <span className="faint">✕</span>
                </button>
              ))}
            </div>
          )}
          <span className="faint" style={{ fontSize: 12.5 }}>
            Others can also add themselves when they open the invite link.
          </span>
        </div>

        {error && <div className="error-text">{error}</div>}
      </div>

      <div className="fab-wrap">
        <button className="btn btn-primary" onClick={submit} disabled={!valid || busy}>
          {busy ? 'Creating…' : 'Create group →'}
        </button>
      </div>
    </div>
  )
}
