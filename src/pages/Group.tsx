import { useCallback, useEffect, useMemo, useState } from 'react'
import ExpenseSheet from '../components/ExpenseSheet'
import Insights from '../components/Insights'
import ProfileSheet from '../components/ProfileSheet'
import SettleSheet from '../components/SettleSheet'
import { Avatar, Brand } from '../components/ui'
import { formatDay } from '../lib/format'
import { toast } from '../lib/toast'
import { api, type Expense, type GroupData, type Member, type Settlement } from '../lib/api'
import { findCategory } from '../lib/categories'
import { getSaved, saveGroup } from '../lib/identity'
import { formatMoney, fromMinor, netBalances, signedMinor, simplifyDebts, toMinor, type Transfer } from '../lib/money'
import { nudgeText, sendNudge, upiLink } from '../lib/upi'
import { inviteUrl, navigate } from '../lib/router'

type Tab = 'expenses' | 'balances' | 'insights'
type SheetState =
  | { kind: 'expense'; expense?: Expense }
  | { kind: 'settle'; initial?: { from: string; to: string; amount: number } }
  | { kind: 'profile' }
  | null

export default function Group({ code }: { code: string }) {
  const [data, setData] = useState<GroupData | null>(null)
  const [loadError, setLoadError] = useState('')
  const [me, setMe] = useState<string | null>(() => getSaved(code)?.memberId ?? null)
  const [tab, setTab] = useState<Tab>('expenses')
  const [sheet, setSheet] = useState<SheetState>(null)
  const [justCreated] = useState(() => new URLSearchParams(location.search).has('new'))

  const load = useCallback(async () => {
    try {
      setData(await api.getGroup(code))
      setLoadError('')
    } catch (e) {
      setLoadError((e as Error).message)
    }
  }, [code])

  useEffect(() => {
    load()
    // Keep everyone roughly in sync without realtime: refresh on focus and every 20s while visible.
    const onVisible = () => document.visibilityState === 'visible' && load()
    document.addEventListener('visibilitychange', onVisible)
    const timer = window.setInterval(() => document.visibilityState === 'visible' && load(), 20000)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      clearInterval(timer)
    }
  }, [load])

  useEffect(() => {
    if (data) saveGroup({ code, name: data.group.name, emoji: data.group.emoji, memberId: me })
  }, [data, me, code])

  if (loadError && !data) {
    return (
      <div className="app">
        <div className="topbar">
          <Brand onClick={() => navigate('/')} />
        </div>
        <div className="empty">
          <div className="emoji">🔍</div>
          <p>{loadError === 'Group not found' ? 'This invite link doesn’t match any group.' : loadError}</p>
          <button className="btn btn-ghost" onClick={() => navigate('/')}>
            Go home
          </button>
        </div>
      </div>
    )
  }

  if (!data) {
    return (
      <div className="app">
        <div className="spinner" aria-label="Loading" />
      </div>
    )
  }

  const meMember = data.members.find((m) => m.id === me)
  if (!meMember) {
    return <Join code={code} data={data} onJoined={(id) => (setMe(id), load())} />
  }

  const close = () => setSheet(null)
  const saved = () => {
    setSheet(null)
    load()
  }

  return (
    <div className="app">
      <div className="topbar">
        <Brand onClick={() => navigate('/')} />
        <div className="row" style={{ gap: 8 }}>
          <button className="btn btn-ghost btn-sm" onClick={() => navigate(`/g/${code}/report`)}>
            ⤓ Export
          </button>
          <ShareButton code={code} name={data.group.name} />
        </div>
      </div>

      <GroupHeader
        data={data}
        me={meMember}
        onSwitch={() => setMe(null)}
        onProfile={() => setSheet({ kind: 'profile' })}
      />

      {justCreated && data.expenses.length === 0 && <InviteCard code={code} name={data.group.name} />}

      <div className="tabs" role="tablist">
        {(['expenses', 'balances', 'insights'] as Tab[]).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </div>

      {tab === 'expenses' && (
        <Activity data={data} me={meMember.id} onOpen={(expense) => setSheet({ kind: 'expense', expense })} onReload={load} code={code} />
      )}
      {tab === 'balances' && (
        <Balances
          code={code}
          data={data}
          me={meMember.id}
          onSettle={(initial) => setSheet({ kind: 'settle', initial })}
          onProfile={() => setSheet({ kind: 'profile' })}
        />
      )}
      {tab === 'insights' && <Insights data={data} me={meMember.id} />}

      <div className="fab-wrap">
        {tab === 'balances' ? (
          <button className="btn btn-primary" onClick={() => setSheet({ kind: 'settle' })}>
            Record a payment
          </button>
        ) : (
          <button className="btn btn-primary" onClick={() => setSheet({ kind: 'expense' })}>
            + Add expense
          </button>
        )}
      </div>

      {sheet?.kind === 'expense' && (
        <ExpenseSheet code={code} data={data} me={meMember.id} expense={sheet.expense} onClose={close} onSaved={saved} />
      )}
      {sheet?.kind === 'settle' && (
        <SettleSheet code={code} data={data} me={meMember.id} initial={sheet.initial} onClose={close} onSaved={saved} />
      )}
      {sheet?.kind === 'profile' && <ProfileSheet code={code} member={meMember} onClose={close} onSaved={saved} />}
    </div>
  )
}

/* ------------------------------------------------------------------ */

function GroupHeader({
  data,
  me,
  onSwitch,
  onProfile,
}: {
  data: GroupData
  me: Member
  onSwitch: () => void
  onProfile: () => void
}) {
  const cur = data.group.currency
  const net = netBalances(data.members.map((m) => m.id), data.expenses, data.settlements).get(me.id) ?? 0
  const total = data.expenses.reduce((a, e) => a + signedMinor(e), 0)

  return (
    <section className="card hero stack" style={{ gap: 16 }}>
      <div className="row">
        <span className="emoji-tile lg">{data.group.emoji}</span>
        <div className="grow">
          <h1 className="display h2 ellipsis">{data.group.name}</h1>
          <div className="row" style={{ gap: 4, marginTop: 6 }}>
            {data.members.slice(0, 6).map((m) => (
              <Avatar key={m.id} member={m} size="sm" />
            ))}
            {data.members.length > 6 && <span className="faint" style={{ fontSize: 12 }}>+{data.members.length - 6}</span>}
          </div>
        </div>
      </div>
      <hr className="divider" />
      <div className="row between" style={{ alignItems: 'flex-end' }}>
        <div>
          <div className="label">
            {net > 0 ? 'you are owed' : net < 0 ? 'you owe' : 'your balance'}
          </div>
          <div className={`big-num num ${net > 0 ? 'pos' : net < 0 ? 'neg' : ''}`} style={{ marginTop: 6 }}>
            {net === 0 ? 'All square' : formatMoney(fromMinor(Math.abs(net)), cur)}
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div className="label">group spend</div>
          <div className="num" style={{ fontWeight: 700, marginTop: 6 }}>
            {formatMoney(fromMinor(total), cur)}
          </div>
        </div>
      </div>
      <div className="faint" style={{ fontSize: 12.5 }}>
        Viewing as <strong className="muted">{me.name}</strong> ·{' '}
        <button className="link" onClick={onProfile}>
          {me.upi_id ? 'edit profile' : 'add your UPI ID'}
        </button>{' '}
        ·{' '}
        <button className="link" onClick={onSwitch}>
          not you?
        </button>
      </div>
    </section>
  )
}

function useShare(code: string, name: string) {
  return async () => {
    const url = inviteUrl(code)
    if (navigator.share) {
      try {
        await navigator.share({ title: `Join ${name} on SplitSmart`, text: `Track our expenses for ${name}:`, url })
        return
      } catch {
        // dismissed or unsupported — fall back to copying
      }
    }
    try {
      await navigator.clipboard.writeText(url)
      toast('Invite link copied')
    } catch {
      prompt('Copy this invite link', url)
    }
  }
}

function ShareButton({ code, name }: { code: string; name: string }) {
  const share = useShare(code, name)
  return (
    <button className="btn btn-ghost btn-sm" onClick={share}>
      ↗ Invite
    </button>
  )
}

function InviteCard({ code, name }: { code: string; name: string }) {
  const share = useShare(code, name)
  return (
    <section className="card stack" style={{ marginTop: 16, borderColor: 'rgba(217,184,120,0.35)' }}>
      <div className="label" style={{ color: 'var(--gold)' }}>
        group created
      </div>
      <div style={{ fontWeight: 600 }}>Send this link to everyone in the group.</div>
      <div className="input num ellipsis" style={{ fontSize: 14 }}>
        {inviteUrl(code)}
      </div>
      <button className="btn btn-ghost btn-block" onClick={share}>
        Share invite link
      </button>
    </section>
  )
}

/* ------------------------------------------------------------------ */

function Join({ code, data, onJoined }: { code: string; data: GroupData; onJoined: (id: string) => void }) {
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const pick = (id: string) => {
    saveGroup({ code, name: data.group.name, emoji: data.group.emoji, memberId: id })
    onJoined(id)
  }

  const add = async () => {
    setBusy(true)
    setError('')
    try {
      const m = await api.addMember(code, name.trim())
      pick(m.id)
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }

  return (
    <div className="app">
      <div className="topbar">
        <Brand onClick={() => navigate('/')} />
      </div>
      <section className="card hero stack" style={{ gap: 16, padding: '26px 20px' }}>
        <span className="emoji-tile lg">{data.group.emoji}</span>
        <span className="label">you’re invited to</span>
        <h1 className="display h1">{data.group.name}</h1>
        <p className="muted" style={{ margin: 0 }}>
          {data.members.length} {data.members.length === 1 ? 'person' : 'people'} · {data.expenses.length} expenses
        </p>
      </section>

      {data.members.length > 0 && (
        <section style={{ marginTop: 28 }}>
          <div className="label" style={{ marginBottom: 12 }}>
            which one is you?
          </div>
          <div className="card" style={{ padding: '4px 14px' }}>
            <div className="list">
              {data.members.map((m) => (
                <button key={m.id} className="list-item" onClick={() => pick(m.id)}>
                  <Avatar member={m} />
                  <span className="grow title">{m.name}</span>
                  <span className="link">That’s me →</span>
                </button>
              ))}
            </div>
          </div>
        </section>
      )}

      <section style={{ marginTop: 28 }} className="stack">
        <div className="label">not on the list?</div>
        <div className="row">
          <input
            className="input"
            placeholder="Your name"
            value={name}
            maxLength={40}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && name.trim() && add()}
          />
          <button className="btn btn-primary" onClick={add} disabled={!name.trim() || busy}>
            Join
          </button>
        </div>
        {error && <div className="error-text">{error}</div>}
      </section>
    </div>
  )
}

/* ------------------------------------------------------------------ */

type ActivityItem = { kind: 'expense'; date: string; at: string; e: Expense } | { kind: 'settle'; date: string; at: string; s: Settlement }

function Activity({
  data,
  me,
  code,
  onOpen,
  onReload,
}: {
  data: GroupData
  me: string
  code: string
  onOpen: (e: Expense) => void
  onReload: () => void
}) {
  const cur = data.group.currency
  const [filter, setFilter] = useState<string>('all')
  const name = (id: string) => (id === me ? 'You' : (data.members.find((m) => m.id === id)?.name ?? 'Someone'))

  const usedCats = useMemo(() => [...new Set(data.expenses.map((e) => e.category))], [data.expenses])

  const items = useMemo(() => {
    const list: ActivityItem[] = [
      ...data.expenses
        .filter((e) => filter === 'all' || e.category === filter)
        .map((e) => ({ kind: 'expense' as const, date: e.spent_on, at: e.created_at, e })),
      ...(filter === 'all'
        ? data.settlements.map((s) => ({ kind: 'settle' as const, date: s.paid_on, at: s.created_at, s }))
        : []),
    ]
    list.sort((a, b) => (a.date === b.date ? b.at.localeCompare(a.at) : b.date.localeCompare(a.date)))
    return list
  }, [data, filter])

  if (data.expenses.length === 0 && data.settlements.length === 0) {
    return (
      <div className="empty">
        <div className="emoji">🧾</div>
        No expenses yet. Add the first one — who paid, how much, and how to split it.
      </div>
    )
  }

  const removeSettlement = async (id: string) => {
    try {
      await api.deleteSettlement(code, id)
      toast('Payment removed')
      onReload()
    } catch (e) {
      toast((e as Error).message)
    }
  }

  let lastDate = ''
  return (
    <div>
      {usedCats.length > 1 && (
        <div className="chips" style={{ flexWrap: 'nowrap', overflowX: 'auto', paddingBottom: 6 }}>
          <button className={`chip ${filter === 'all' ? 'on' : ''}`} onClick={() => setFilter('all')}>
            All
          </button>
          {usedCats.map((k) => {
            const c = findCategory(k, data.categories)
            return (
              <button key={k} className={`chip ${filter === k ? 'on' : ''}`} onClick={() => setFilter(k)}>
                {c.emoji} {c.name}
              </button>
            )
          })}
        </div>
      )}

      {items.map((item) => {
        const sep = item.date !== lastDate
        lastDate = item.date
        return (
          <div key={item.kind === 'expense' ? item.e.id : item.s.id}>
            {sep && <div className="label date-sep">{formatDay(item.date)}</div>}
            {item.kind === 'expense' ? (
              <ExpenseRow e={item.e} data={data} me={me} name={name} onOpen={onOpen} />
            ) : (
              <div className="list-item">
                <span className="emoji-tile">🤝</span>
                <span className="grow">
                  <div className="title ellipsis">
                    {name(item.s.from_member)} paid {name(item.s.to_member)}
                  </div>
                  <div className="sub">{item.s.note ?? 'Settlement'}</div>
                </span>
                <span style={{ textAlign: 'right' }}>
                  <div className="num" style={{ fontWeight: 600 }}>
                    {formatMoney(item.s.amount, cur)}
                  </div>
                  <button className="link" style={{ fontSize: 12, color: 'var(--text-3)' }} onClick={() => removeSettlement(item.s.id)}>
                    undo
                  </button>
                </span>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

function ExpenseRow({
  e,
  data,
  me,
  name,
  onOpen,
}: {
  e: Expense
  data: GroupData
  me: string
  name: (id: string) => string
  onOpen: (e: Expense) => void
}) {
  const cur = data.group.currency
  const cat = findCategory(e.category, data.categories)
  const refund = e.kind === 'refund'
  const sign = refund ? -1 : 1
  const paid = toMinor(e.payers.find((p) => p.member_id === me)?.amount ?? 0)
  const share = toMinor(e.splits.find((s) => s.member_id === me)?.amount ?? 0)
  const diff = sign * (paid - share)
  const foreign = e.currency && e.currency !== cur
  const who = e.payers.length === 1 ? name(e.payers[0].member_id) : `${e.payers.length} people`
  const payerText = refund ? `${who} received` : `${who} paid`

  return (
    <button className="list-item" onClick={() => onOpen(e)}>
      <span className="emoji-tile">{refund ? '↩️' : cat.emoji}</span>
      <span className="grow">
        <div className="title ellipsis">
          {e.description}
          {e.receipts.length > 0 && <span className="faint"> 📎</span>}
        </div>
        <div className="sub ellipsis">
          {payerText} · {refund ? 'Refund' : cat.name}
          {foreign && ` · ${formatMoney(e.original_amount ?? 0, e.currency!)}`}
        </div>
      </span>
      <span style={{ textAlign: 'right' }}>
        <div className={`num ${refund ? 'pos' : ''}`} style={{ fontWeight: 600 }}>
          {refund ? '−' : ''}
          {formatMoney(e.amount, cur)}
        </div>
        <div className={`num ${diff > 0 ? 'pos' : diff < 0 ? 'neg' : 'faint'}`} style={{ fontSize: 12 }}>
          {diff > 0
            ? `${refund ? 'you get' : 'you lent'} ${formatMoney(fromMinor(diff), cur)}`
            : diff < 0
              ? `${refund ? 'you hold' : 'you owe'} ${formatMoney(fromMinor(-diff), cur)}`
              : 'not involved'}
        </div>
      </span>
    </button>
  )
}

/* ------------------------------------------------------------------ */

function Balances({
  code,
  data,
  me,
  onSettle,
  onProfile,
}: {
  code: string
  data: GroupData
  me: string
  onSettle: (t: { from: string; to: string; amount: number }) => void
  onProfile: () => void
}) {
  const cur = data.group.currency
  const net = netBalances(data.members.map((m) => m.id), data.expenses, data.settlements)
  const transfers = simplifyDebts(net)
  const member = (id: string) => data.members.find((m) => m.id === id)!
  const label = (id: string) => (id === me ? 'You' : member(id).name)
  const mine = transfers.filter((t) => t.from === me || t.to === me)
  const others = transfers.filter((t) => t.from !== me && t.to !== me)
  const meMember = member(me)
  const owedToMe = transfers.filter((t) => t.to === me)

  const nudge = (list: Transfer[]) =>
    sendNudge(
      nudgeText(
        data.group.name,
        code,
        cur,
        list.map((t) => ({
          debtor: member(t.from).name,
          creditor: member(t.to).name,
          amount: fromMinor(t.amount),
          upi: member(t.to).upi_id,
        })),
      ),
    )

  const transferRow = (t: Transfer) => {
    const payee = member(t.to)
    const canUpi = t.from === me && cur === 'INR' && !!payee.upi_id
    return (
      <div key={`${t.from}-${t.to}`} className="transfer">
        <div className="row" style={{ gap: 10 }}>
          <Avatar member={member(t.from)} size="sm" />
          <span className="faint">→</span>
          <Avatar member={payee} size="sm" />
          <span className="grow" style={{ fontSize: 14 }}>
            <strong>{label(t.from)}</strong> <span className="muted">{t.from === me ? 'pay' : 'pays'}</span>{' '}
            <strong>{label(t.to)}</strong>
          </span>
          <span className="num" style={{ fontWeight: 700 }}>
            {formatMoney(fromMinor(t.amount), cur)}
          </span>
        </div>
        <div className="transfer-actions">
          {canUpi && (
            <a
              className="btn btn-primary btn-sm"
              href={upiLink({
                vpa: payee.upi_id!,
                name: payee.name,
                amount: fromMinor(t.amount),
                note: `SplitSmart · ${data.group.name}`,
              })}
              onClick={() => setTimeout(() => onSettle(t), 600)}
            >
              Pay via UPI
            </a>
          )}
          {t.to === me && (
            <button className="btn btn-ghost btn-sm" onClick={() => nudge([t])}>
              🔔 Nudge
            </button>
          )}
          <button className="btn btn-ghost btn-sm" onClick={() => onSettle(t)}>
            {canUpi ? 'Mark paid' : 'Settle'}
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="stack" style={{ gap: 18 }}>
      <section className="card" style={{ padding: '14px 14px 6px' }}>
        <div className="row between" style={{ marginBottom: 4 }}>
          <div className="label">fewest payments to settle up</div>
          {transfers.length > 0 && (
            <button className="link" onClick={() => nudge(transfers)}>
              Remind everyone
            </button>
          )}
        </div>
        {transfers.length === 0 ? (
          <div className="empty" style={{ padding: '24px 0' }}>
            <div className="emoji">✨</div>
            Everyone’s square.
          </div>
        ) : (
          <div className="list">{[...mine, ...others].map(transferRow)}</div>
        )}
      </section>

      {cur === 'INR' && owedToMe.length > 0 && !meMember.upi_id && (
        <button className="card flat row" style={{ textAlign: 'left', width: '100%' }} onClick={onProfile}>
          <span style={{ fontSize: 22 }}>⚡</span>
          <span className="grow small">
            <strong>Add your UPI ID</strong>
            <div className="faint">People who owe you get a one-tap “Pay via UPI” button, and nudges include it.</div>
          </span>
          <span className="faint">›</span>
        </button>
      )}

      <section className="card" style={{ padding: '14px 14px 4px' }}>
        <div className="label" style={{ marginBottom: 4 }}>
          net balances
        </div>
        <div className="list">
          {data.members.map((m) => {
            const v = net.get(m.id) ?? 0
            return (
              <div key={m.id} className="list-item">
                <Avatar member={m} />
                <span className="grow">
                  <div className="title">{m.id === me ? `${m.name} (you)` : m.name}</div>
                  {m.upi_id && <div className="sub">UPI · {m.upi_id}</div>}
                </span>
                <span className={`pill num ${v > 0 ? 'pos' : v < 0 ? 'neg' : ''}`}>
                  {v > 0 ? 'gets back ' : v < 0 ? 'owes ' : 'settled'}
                  {v !== 0 && formatMoney(fromMinor(Math.abs(v)), cur)}
                </span>
              </div>
            )
          })}
        </div>
      </section>
    </div>
  )
}
