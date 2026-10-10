import { useEffect, useMemo, useState } from 'react'
import { Brand } from '../components/ui'
import { api, type GroupData } from '../lib/api'
import { findCategory } from '../lib/categories'
import { formatDay } from '../lib/format'
import { getSaved } from '../lib/identity'
import { formatMoney, fromMinor, netBalances, signedMinor, simplifyDebts, toMinor } from '../lib/money'
import { receiptUrl } from '../lib/receipts'
import { download, expensesCsv, filterExpenses, slug } from '../lib/report'
import { navigate } from '../lib/router'

const shortDate = (iso: string) =>
  new Date(iso + 'T00:00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short' })

export default function Report({ code }: { code: string }) {
  const [data, setData] = useState<GroupData | null>(null)
  const [error, setError] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [generated] = useState(() => new Date().toLocaleDateString())
  const [memberId, setMemberId] = useState<string>(() => getSaved(code)?.memberId ?? '')

  useEffect(() => {
    api.getGroup(code).then(setData, (e: Error) => setError(e.message))
  }, [code])

  const expenses = useMemo(
    () => (data ? filterExpenses(data, { from, to, memberId: memberId || null }) : []),
    [data, from, to, memberId],
  )

  if (error) return <div className="app"><div className="empty">{error}</div></div>
  if (!data) return <div className="app"><div className="spinner" aria-label="Loading" /></div>

  const cur = data.group.currency
  const money = (minor: number) => formatMoney(fromMinor(minor), cur, { decimals: true })
  const name = (id: string) => data.members.find((m) => m.id === id)?.name ?? '—'
  const person = data.members.find((m) => m.id === memberId)

  const total = expenses.reduce((a, e) => a + signedMinor(e), 0)
  const shareOf = (e: (typeof expenses)[number]) =>
    signedMinor(e, e.splits.find((s) => s.member_id === memberId)?.amount ?? 0)
  // Out-of-pocket spend only: a refund someone received isn't money they paid.
  const paidBy = (e: (typeof expenses)[number]) =>
    e.kind === 'refund' ? 0 : toMinor(e.payers.find((p) => p.member_id === memberId)?.amount ?? 0)
  const myShare = person ? expenses.reduce((a, e) => a + shareOf(e), 0) : 0
  const myPaid = person ? expenses.reduce((a, e) => a + paidBy(e), 0) : 0

  const byCat = new Map<string, number>()
  for (const e of expenses) byCat.set(e.category, (byCat.get(e.category) ?? 0) + (person ? shareOf(e) : signedMinor(e)))
  const catRows = [...byCat].filter(([, v]) => v !== 0).sort((a, b) => b[1] - a[1])

  const transfers = simplifyDebts(netBalances(data.members.map((m) => m.id), data.expenses, data.settlements))
  const range =
    from || to
      ? `${from ? formatDay(from) : 'Start'} – ${to ? formatDay(to) : 'today'}`
      : expenses.length
        ? `${formatDay(expenses[0].spent_on)} – ${formatDay(expenses[expenses.length - 1].spent_on)}`
        : 'No expenses'

  const fileBase = `${slug(data.group.name)}${person ? '-' + slug(person.name) : ''}`

  return (
    <div className="app report-app">
      <div className="no-print">
        <div className="topbar">
          <Brand onClick={() => navigate('/')} />
          <button className="icon-btn" onClick={() => navigate(`/g/${code}`)} aria-label="Back to group">
            ←
          </button>
        </div>
        <h1 className="display h2" style={{ marginBottom: 6 }}>
          Export <em>& claims.</em>
        </h1>
        <p className="muted" style={{ marginTop: 0 }}>
          Download a spreadsheet, or save a PDF report — handy for work-travel reimbursement.
        </p>

        <div className="card stack" style={{ gap: 14 }}>
          <label className="field">
            <span className="label">expenses for</span>
            <select className="select" value={memberId} onChange={(e) => setMemberId(e.target.value)}>
              <option value="">Whole group</option>
              {data.members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name} — their share only
                </option>
              ))}
            </select>
          </label>
          <div className="row">
            <label className="field grow">
              <span className="label">from</span>
              <input className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            </label>
            <label className="field grow">
              <span className="label">to</span>
              <input className="input" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
            </label>
          </div>
          <div className="row">
            <button
              className="btn btn-ghost grow"
              disabled={!expenses.length}
              onClick={() => download(`${fileBase}.csv`, expensesCsv(data, expenses))}
            >
              ⤓ CSV
            </button>
            <button className="btn btn-primary grow" disabled={!expenses.length} onClick={() => window.print()}>
              Save as PDF
            </button>
          </div>
          <span className="faint small">“Save as PDF” opens the print dialog — choose “Save as PDF” as the destination.</span>
        </div>

        <div className="label" style={{ margin: '28px 0 10px' }}>
          preview
        </div>
      </div>

      <article className="report">
        <header className="report-head">
          <div>
            <div className="report-kicker">SplitSmart expense report</div>
            <h1>
              {data.group.emoji} {data.group.name}
            </h1>
            <div className="report-meta">
              {range}
              {person && <> · Prepared for <strong>{person.name}</strong></>}
            </div>
          </div>
          <div className="report-meta right">Generated {generated}</div>
        </header>

        <section className="report-stats">
          <div>
            <span>{person ? `${person.name}’s share` : 'Total spend'}</span>
            <strong>{money(person ? myShare : total)}</strong>
          </div>
          {person && (
            <div>
              <span>Paid by {person.name}</span>
              <strong>{money(myPaid)}</strong>
            </div>
          )}
          <div>
            <span>Expenses</span>
            <strong>{expenses.length}</strong>
          </div>
          <div>
            <span>Currency</span>
            <strong>{cur}</strong>
          </div>
        </section>

        {catRows.length > 0 && (
          <section>
            <h2>By category</h2>
            <table>
              <tbody>
                {catRows.map(([k, v]) => {
                  const c = findCategory(k, data.categories)
                  return (
                    <tr key={k}>
                      <td>
                        {c.emoji} {c.name}
                      </td>
                      <td className="r">{money(v)}</td>
                      <td className="r muted">
                        {Math.round((v / (person ? myShare || 1 : total || 1)) * 100)}%
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </section>
        )}

        <section>
          <h2>Expenses</h2>
          {expenses.length === 0 ? (
            <p className="muted">Nothing in this range.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Description</th>
                  <th>Paid by</th>
                  <th className="r">Amount</th>
                  {person && <th className="r">Share</th>}
                </tr>
              </thead>
              <tbody>
                {expenses.map((e) => {
                  const c = findCategory(e.category, data.categories)
                  const refund = e.kind === 'refund'
                  const foreign = e.currency && e.currency !== cur
                  return (
                    <tr key={e.id}>
                      <td className="nowrap">{shortDate(e.spent_on)}</td>
                      <td>
                        {e.description}
                        <div className="muted small">
                          {refund ? 'Refund' : c.name}
                          {foreign &&
                            ` · ${formatMoney(e.original_amount ?? 0, e.currency!)} @ ${e.fx_rate}`}
                          {e.receipts.map((r, i) => (
                            <a key={r} href={receiptUrl(r)} target="_blank" rel="noreferrer">
                              {' '}
                              · receipt{e.receipts.length > 1 ? ` ${i + 1}` : ''}
                            </a>
                          ))}
                        </div>
                      </td>
                      <td>{e.payers.map((p) => name(p.member_id)).join(', ')}</td>
                      <td className="r nowrap">{money(signedMinor(e))}</td>
                      {person && <td className="r nowrap">{money(shareOf(e))}</td>}
                    </tr>
                  )
                })}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={3}>Total</td>
                  <td className="r">{money(total)}</td>
                  {person && <td className="r">{money(myShare)}</td>}
                </tr>
              </tfoot>
            </table>
          )}
        </section>

        {!person && (
          <section>
            <h2>To settle up</h2>
            {transfers.length === 0 ? (
              <p className="muted">Everyone is square.</p>
            ) : (
              <table>
                <tbody>
                  {transfers.map((t) => (
                    <tr key={`${t.from}-${t.to}`}>
                      <td>
                        {name(t.from)} → {name(t.to)}
                      </td>
                      <td className="r">{money(t.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <p className="muted small">Balances cover all expenses and recorded payments, not just the range above.</p>
          </section>
        )}
        <p className="muted small">
          Amounts in {cur}. Foreign-currency expenses are converted at the rate recorded with each expense.
        </p>
      </article>
    </div>
  )
}
