import { useMemo, useState } from 'react'
import type { GroupData } from '../lib/api'
import { findCategory } from '../lib/categories'
import { formatMoney, fromMinor, memberTotals, toMinor } from '../lib/money'
import { Avatar } from './ui'

// Validated (dark surface #161618): adjacent CVD ΔE 22.6, both >= 3:1 contrast.
const PAID = '#3f8fd9'
const SHARE = '#b48a3c'

export default function Insights({ data, me }: { data: GroupData; me: string }) {
  const [scope, setScope] = useState<'group' | 'me'>('group')
  const cur = data.group.currency
  const money = (minor: number) => formatMoney(fromMinor(minor), cur)

  const byCategory = useMemo(() => {
    const totals = new Map<string, number>()
    for (const e of data.expenses) {
      const v =
        scope === 'group'
          ? toMinor(e.amount)
          : toMinor(e.splits.find((s) => s.member_id === me)?.amount ?? 0)
      if (v) totals.set(e.category, (totals.get(e.category) ?? 0) + v)
    }
    const rows = [...totals]
      .map(([key, v]) => ({ ...findCategory(key, data.categories), value: v }))
      .sort((a, b) => b.value - a.value)
    const sum = rows.reduce((a, r) => a + r.value, 0)
    return { rows, sum }
  }, [data, scope, me])

  const people = useMemo(
    () => data.members.map((m) => ({ member: m, ...memberTotals(m.id, data.expenses) })),
    [data],
  )
  const peopleMax = Math.max(1, ...people.flatMap((p) => [p.paid, p.share]))

  if (data.expenses.length === 0) {
    return (
      <div className="empty">
        <div className="emoji">📊</div>
        Add a few expenses to see where the money goes.
      </div>
    )
  }

  const max = byCategory.rows[0]?.value || 1

  return (
    <div className="stack" style={{ gap: 18 }}>
      <div className="segmented">
        <button className={scope === 'group' ? 'on' : ''} onClick={() => setScope('group')}>
          Group spend
        </button>
        <button className={scope === 'me' ? 'on' : ''} onClick={() => setScope('me')}>
          My share
        </button>
      </div>

      <section className="card stack" style={{ gap: 14 }}>
        <div>
          <div className="label">{scope === 'group' ? 'total group spend' : 'your total share'}</div>
          <div className="big-num num" style={{ marginTop: 6 }}>
            {money(byCategory.sum)}
          </div>
        </div>
        <hr className="divider" />
        <div className="label">by category</div>
        {byCategory.rows.length === 0 && <div className="faint">Nothing on your tab yet.</div>}
        {byCategory.rows.map((r) => {
          const pct = byCategory.sum ? Math.round((r.value / byCategory.sum) * 100) : 0
          return (
            <div key={r.key} className="stack" style={{ gap: 6 }} title={`${r.name}: ${money(r.value)} (${pct}%)`}>
              <div className="row between" style={{ fontSize: 14 }}>
                <span className="ellipsis">
                  {r.emoji} {r.name}
                </span>
                <span className="num">
                  {money(r.value)} <span className="faint">· {pct}%</span>
                </span>
              </div>
              <div className="bar-track">
                <div className="bar-fill" style={{ width: `${(r.value / max) * 100}%`, background: SHARE }} />
              </div>
            </div>
          )
        })}
      </section>

      <section className="card stack" style={{ gap: 14 }}>
        <div className="row between">
          <div className="label">paid vs share</div>
          <div className="row" style={{ gap: 12, fontSize: 12 }}>
            <span className="row" style={{ gap: 6 }}>
              <span className="legend-dot" style={{ background: PAID }} /> <span className="muted">Paid</span>
            </span>
            <span className="row" style={{ gap: 6 }}>
              <span className="legend-dot" style={{ background: SHARE }} /> <span className="muted">Share</span>
            </span>
          </div>
        </div>
        {people.map(({ member, paid, share }) => (
          <div key={member.id} className="row" style={{ alignItems: 'flex-start' }}>
            <Avatar member={member} size="sm" />
            <div className="grow stack" style={{ gap: 5 }}>
              <div className="row between" style={{ fontSize: 14 }}>
                <span className="ellipsis" style={{ fontWeight: 600 }}>
                  {member.id === me ? 'You' : member.name}
                </span>
                <span className="num muted" style={{ fontSize: 13 }}>
                  {money(paid)} / {money(share)}
                </span>
              </div>
              <div className="bar-track" style={{ height: 6 }} title={`Paid ${money(paid)}`}>
                <div className="bar-fill" style={{ width: `${(paid / peopleMax) * 100}%`, background: PAID }} />
              </div>
              <div className="bar-track" style={{ height: 6 }} title={`Share ${money(share)}`}>
                <div className="bar-fill" style={{ width: `${(share / peopleMax) * 100}%`, background: SHARE }} />
              </div>
            </div>
          </div>
        ))}
      </section>
    </div>
  )
}
