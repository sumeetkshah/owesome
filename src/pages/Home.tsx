import { useState } from 'react'
import { Brand } from '../components/ui'
import { savedGroups } from '../lib/identity'
import { navigate } from '../lib/router'

export default function Home() {
  const groups = savedGroups()
  const [link, setLink] = useState('')
  const [linkError, setLinkError] = useState('')

  const openLink = () => {
    const m = link.trim().match(/(?:\/g\/)?([a-z0-9]{8,})\/?$/i)
    if (!m) {
      setLinkError('That doesn’t look like a SplitSmart invite link.')
      return
    }
    navigate(`/g/${m[1].toLowerCase()}`)
  }

  return (
    <div className="app">
      <div className="topbar">
        <Brand />
      </div>

      <section className="card hero stack" style={{ padding: '28px 22px', gap: 18 }}>
        <span className="label">group expenses, sorted</span>
        <h1 className="display h1">
          Split bills,
          <br />
          <em>not friendships.</em>
        </h1>
        <p className="muted" style={{ margin: 0 }}>
          Trips, offsites, flat dinners. Log who paid, split it any way you like, and settle up in the fewest
          transfers. No sign-up — just share a link.
        </p>
        <button className="btn btn-primary btn-block" onClick={() => navigate('/new')}>
          Start a group →
        </button>
      </section>

      {groups.length > 0 && (
        <section style={{ marginTop: 32 }}>
          <div className="label" style={{ marginBottom: 12 }}>
            your groups
          </div>
          <div className="card" style={{ padding: '4px 14px' }}>
            <div className="list">
              {groups.map((g) => (
                <button key={g.code} className="list-item" onClick={() => navigate(`/g/${g.code}`)}>
                  <span className="emoji-tile">{g.emoji}</span>
                  <span className="grow">
                    <div className="title ellipsis">{g.name}</div>
                    <div className="sub">
                      Opened{' '}
                      {new Date(g.lastOpened).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}
                    </div>
                  </span>
                  <span className="faint">›</span>
                </button>
              ))}
            </div>
          </div>
        </section>
      )}

      <section style={{ marginTop: 32 }} className="stack">
        <div className="label">got an invite link?</div>
        <div className="row">
          <input
            className="input"
            placeholder="Paste link or code"
            value={link}
            onChange={(e) => {
              setLink(e.target.value)
              setLinkError('')
            }}
            onKeyDown={(e) => e.key === 'Enter' && openLink()}
          />
          <button className="btn btn-ghost" onClick={openLink} disabled={!link.trim()}>
            Join
          </button>
        </div>
        {linkError && <div className="error-text">{linkError}</div>}
      </section>

      <section style={{ marginTop: 40, alignItems: 'stretch' }} className="row" aria-label="Features">
        {[
          ['⚖️', 'Equal, exact, % or shares'],
          ['🧾', 'Multiple payers'],
          ['🔁', 'Fewest settle-ups'],
        ].map(([e, t]) => (
          <div key={t} className="card flat grow" style={{ padding: 14, textAlign: 'center' }}>
            <div style={{ fontSize: 22 }}>{e}</div>
            <div className="faint" style={{ fontSize: 12, marginTop: 6 }}>
              {t}
            </div>
          </div>
        ))}
      </section>
    </div>
  )
}
