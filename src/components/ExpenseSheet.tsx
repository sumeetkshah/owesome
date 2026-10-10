import { useState } from 'react'
import { api, type Expense, type GroupData, type Payer, type Split, type SplitType } from '../lib/api'
import { allCategories, customKey } from '../lib/categories'
import { allocate, currencySymbol, formatMoney, fromMinor, toMinor } from '../lib/money'
import { today } from '../lib/format'
import { toast } from '../lib/toast'
import { Avatar, Sheet } from './ui'

interface Props {
  code: string
  data: GroupData
  me: string
  expense?: Expense
  onClose: () => void
  onSaved: () => void
}

const SPLIT_LABELS: Record<SplitType, string> = {
  equal: 'Equally',
  exact: 'Exact',
  percent: '%',
  shares: 'Shares',
}

const num = (s: string | undefined) => {
  const n = parseFloat(s ?? '')
  return Number.isFinite(n) && n > 0 ? n : 0
}

const strip = (n: number) => String(Math.round(n * 100) / 100)

export default function ExpenseSheet({ code, data, me, expense, onClose, onSaved }: Props) {
  const { members, group } = data
  const cur = group.currency
  const money = (minor: number) => formatMoney(fromMinor(minor), cur, { decimals: minor % 100 !== 0 })

  const [amount, setAmount] = useState(expense ? strip(expense.amount) : '')
  const [description, setDescription] = useState(expense?.description ?? '')
  const [category, setCategory] = useState(expense?.category ?? 'food')
  const [spentOn, setSpentOn] = useState(expense?.spent_on ?? today())
  const [notes, setNotes] = useState(expense?.notes ?? '')

  const [multiPayer, setMultiPayer] = useState((expense?.payers.length ?? 1) > 1)
  const [payer, setPayer] = useState(expense?.payers[0]?.member_id ?? me)
  const [payerAmounts, setPayerAmounts] = useState<Record<string, string>>(() =>
    Object.fromEntries(expense?.payers.map((p) => [p.member_id, strip(p.amount)]) ?? []),
  )

  const [splitType, setSplitType] = useState<SplitType>(expense?.split_type ?? 'equal')
  const [included, setIncluded] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(
      members.map((m) => [m.id, expense ? expense.splits.some((s) => s.member_id === m.id) : true]),
    ),
  )
  const [values, setValues] = useState<Record<string, string>>(() => {
    if (!expense || expense.split_type === 'equal') return {}
    return Object.fromEntries(
      expense.splits.map((s) => [
        s.member_id,
        strip(expense.split_type === 'exact' ? s.amount : (s.weight ?? 0)),
      ]),
    )
  })

  const [newCat, setNewCat] = useState<{ name: string; emoji: string } | null>(null)
  const [customCats, setCustomCats] = useState(data.categories)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const total = toMinor(num(amount))

  const payers = ((): { list: Payer[]; error?: string } => {
    if (!multiPayer) return { list: [{ member_id: payer, amount: fromMinor(total) }] }
    const list = members
      .map((m) => ({ member_id: m.id, minor: toMinor(num(payerAmounts[m.id])) }))
      .filter((p) => p.minor > 0)
    const sum = list.reduce((a, p) => a + p.minor, 0)
    const diff = total - sum
    return {
      list: list.map((p) => ({ member_id: p.member_id, amount: fromMinor(p.minor) })),
      error:
        diff === 0 ? undefined : diff > 0 ? `${money(diff)} still to assign` : `${money(-diff)} over the total`,
    }
  })()

  const splits = ((): { list: Split[]; preview: Record<string, number>; status: string; ok: boolean } => {
    const ids = members.map((m) => m.id)
    let list: { member_id: string; minor: number; weight: number | null }[] = []
    let status = ''
    let ok = true

    if (splitType === 'equal') {
      const chosen = ids.filter((id) => included[id])
      const parts = allocate(total, chosen.map(() => 1))
      list = chosen.map((id, i) => ({ member_id: id, minor: parts[i], weight: null }))
      ok = chosen.length > 0
      status = ok ? `${chosen.length} ${chosen.length === 1 ? 'person' : 'people'}` : 'Pick at least one person'
    } else if (splitType === 'exact') {
      list = ids
        .map((id) => ({ member_id: id, minor: toMinor(num(values[id])), weight: null }))
        .filter((s) => s.minor > 0)
      const diff = total - list.reduce((a, s) => a + s.minor, 0)
      ok = diff === 0 && list.length > 0
      status = diff === 0 ? 'Adds up' : diff > 0 ? `${money(diff)} left` : `${money(-diff)} over`
    } else {
      const weights = ids.map((id) => num(values[id]))
      const parts = allocate(total, weights)
      list = ids
        .map((id, i) => ({ member_id: id, minor: parts[i], weight: weights[i] }))
        .filter((s) => s.weight > 0)
      const sum = weights.reduce((a, b) => a + b, 0)
      if (splitType === 'percent') {
        const left = Math.round((100 - sum) * 100) / 100
        ok = left === 0
        status = left === 0 ? 'Adds up to 100%' : left > 0 ? `${left}% left` : `${-left}% over`
      } else {
        ok = sum > 0
        status = ok ? `${strip(sum)} shares total` : 'Give someone at least one share'
      }
    }

    return {
      list: list.map((s) => ({ member_id: s.member_id, amount: fromMinor(s.minor), weight: s.weight })),
      preview: Object.fromEntries(list.map((s) => [s.member_id, s.minor])),
      status,
      ok,
    }
  })()

  const canSave = total > 0 && description.trim() && !payers.error && splits.ok && !busy

  const switchSplit = (t: SplitType) => {
    setSplitType(t)
    // Seed sensible starting values so the form isn't blank.
    const chosen = members.filter((m) => included[m.id] !== false)
    if (t === 'shares') setValues(Object.fromEntries(chosen.map((m) => [m.id, '1'])))
    else if (t === 'percent') {
      const each = allocate(10000, chosen.map(() => 1))
      setValues(Object.fromEntries(chosen.map((m, i) => [m.id, strip(each[i] / 100)])))
    } else if (t === 'exact') {
      const each = allocate(total, chosen.map(() => 1))
      setValues(Object.fromEntries(chosen.map((m, i) => [m.id, total ? strip(fromMinor(each[i])) : ''])))
    }
  }

  const createCategory = async () => {
    if (!newCat?.name.trim()) return
    try {
      const c = await api.addCategory(code, newCat.name.trim(), newCat.emoji)
      setCustomCats((prev) => [...prev.filter((x) => x.id !== c.id), c])
      setCategory(customKey(c))
      setNewCat(null)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const save = async () => {
    setBusy(true)
    setError('')
    try {
      await api.saveExpense(code, {
        id: expense?.id,
        description: description.trim(),
        amount: fromMinor(total),
        category,
        split_type: splitType,
        spent_on: spentOn,
        notes: notes.trim() || undefined,
        created_by: expense ? undefined : me,
        payers: payers.list,
        splits: splits.list,
      })
      toast(expense ? 'Expense updated' : 'Expense added')
      onSaved()
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }

  const remove = async () => {
    if (!expense) return
    setBusy(true)
    try {
      await api.deleteExpense(code, expense.id)
      toast('Expense deleted')
      onSaved()
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }

  const [confirmDelete, setConfirmDelete] = useState(false)

  return (
    <Sheet title={expense ? 'Edit expense' : 'Add expense'} onClose={onClose}>
      <div className="amount-input">
        <span className="sym">{currencySymbol(cur)}</span>
        <input
          inputMode="decimal"
          placeholder="0"
          value={amount}
          autoFocus={!expense}
          aria-label="Amount"
          style={{ width: `${Math.max(amount.length, 1) + 0.6}ch` }}
          onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, '').replace(/(\..*?)\..*/, '$1'))}
        />
      </div>

      <div className="stack" style={{ gap: 20 }}>
        <input
          className="input"
          placeholder="What was it for?"
          value={description}
          maxLength={120}
          onChange={(e) => setDescription(e.target.value)}
        />

        <div className="field">
          <span className="label">category</span>
          <div className="chips">
            {allCategories(customCats).map((c) => (
              <button
                key={c.key}
                className={`chip ${category === c.key ? 'on' : ''}`}
                onClick={() => setCategory(c.key)}
              >
                {c.emoji} {c.name}
              </button>
            ))}
            {!newCat && (
              <button className="chip chip-dashed" onClick={() => setNewCat({ name: '', emoji: '🏷️' })}>
                + New
              </button>
            )}
          </div>
          {newCat && (
            <div className="row">
              <input
                className="input input-sm"
                style={{ width: 56, textAlign: 'center' }}
                value={newCat.emoji}
                aria-label="Category emoji"
                onChange={(e) => setNewCat({ ...newCat, emoji: [...e.target.value].slice(-2).join('') })}
              />
              <input
                className="input input-sm"
                placeholder="Category name"
                value={newCat.name}
                maxLength={30}
                autoFocus
                onChange={(e) => setNewCat({ ...newCat, name: e.target.value })}
                onKeyDown={(e) => e.key === 'Enter' && createCategory()}
              />
              <button className="btn btn-ghost btn-sm" onClick={createCategory} disabled={!newCat.name.trim()}>
                Add
              </button>
              <button className="link" onClick={() => setNewCat(null)}>
                Cancel
              </button>
            </div>
          )}
        </div>

        <div className="field">
          <span className="label">date</span>
          <input className="input" type="date" value={spentOn} onChange={(e) => setSpentOn(e.target.value)} />
        </div>

        <hr className="divider" />

        <div className="field">
          <div className="row between">
            <span className="label">paid by</span>
            <label className="row" style={{ gap: 8, fontSize: 13 }}>
              <span className="muted">Multiple payers</span>
              <button
                className={`toggle ${multiPayer ? 'on' : ''}`}
                role="switch"
                aria-checked={multiPayer}
                onClick={() => {
                  if (!multiPayer && total) setPayerAmounts({ [payer]: strip(fromMinor(total)) })
                  setMultiPayer(!multiPayer)
                }}
              />
            </label>
          </div>
          {!multiPayer ? (
            <div className="chips">
              {members.map((m) => (
                <button
                  key={m.id}
                  className={`chip ${payer === m.id ? 'on' : ''}`}
                  onClick={() => setPayer(m.id)}
                >
                  <Avatar member={m} size="sm" /> {m.id === me ? 'You' : m.name}
                </button>
              ))}
            </div>
          ) : (
            <div>
              {members.map((m) => (
                <div key={m.id} className="split-row">
                  <Avatar member={m} size="sm" />
                  <span className="name ellipsis">{m.id === me ? 'You' : m.name}</span>
                  <input
                    className="input input-sm value num"
                    inputMode="decimal"
                    placeholder="0"
                    value={payerAmounts[m.id] ?? ''}
                    onChange={(e) => setPayerAmounts({ ...payerAmounts, [m.id]: e.target.value })}
                  />
                </div>
              ))}
              <div className={`status-bar ${payers.error ? 'bad' : 'ok'}`}>
                <span>{payers.error ?? 'Adds up'}</span>
                <span className="num">{money(total)}</span>
              </div>
            </div>
          )}
        </div>

        <hr className="divider" />

        <div className="field">
          <span className="label">split</span>
          <div className="segmented" role="tablist">
            {(Object.keys(SPLIT_LABELS) as SplitType[]).map((t) => (
              <button
                key={t}
                role="tab"
                aria-selected={splitType === t}
                className={splitType === t ? 'on' : ''}
                onClick={() => switchSplit(t)}
              >
                {SPLIT_LABELS[t]}
              </button>
            ))}
          </div>

          <div>
            {members.map((m) => {
              const share = splits.preview[m.id] ?? 0
              return (
                <div key={m.id} className="split-row">
                  {splitType === 'equal' && (
                    <button
                      className={`check ${included[m.id] ? 'on' : ''}`}
                      aria-label={`Include ${m.name}`}
                      onClick={() => setIncluded({ ...included, [m.id]: !included[m.id] })}
                    >
                      {included[m.id] ? '✓' : ''}
                    </button>
                  )}
                  <Avatar member={m} size="sm" />
                  <span className="name ellipsis">{m.id === me ? 'You' : m.name}</span>

                  {splitType === 'equal' && (
                    <span className={`num ${share ? '' : 'faint'}`}>{money(share)}</span>
                  )}

                  {splitType === 'exact' && (
                    <input
                      className="input input-sm value num"
                      inputMode="decimal"
                      placeholder="0"
                      value={values[m.id] ?? ''}
                      onChange={(e) => setValues({ ...values, [m.id]: e.target.value })}
                    />
                  )}

                  {splitType === 'percent' && (
                    <>
                      <span className="faint num" style={{ fontSize: 12 }}>
                        {money(share)}
                      </span>
                      <div className="row" style={{ gap: 4, width: 84 }}>
                        <input
                          className="input input-sm num"
                          inputMode="decimal"
                          placeholder="0"
                          style={{ textAlign: 'right' }}
                          value={values[m.id] ?? ''}
                          onChange={(e) => setValues({ ...values, [m.id]: e.target.value })}
                        />
                        <span className="faint">%</span>
                      </div>
                    </>
                  )}

                  {splitType === 'shares' && (
                    <>
                      <span className="faint num" style={{ fontSize: 12 }}>
                        {money(share)}
                      </span>
                      <div className="row" style={{ gap: 6 }}>
                        <button
                          className="icon-btn"
                          style={{ width: 30, height: 30, fontSize: 15, borderRadius: 9 }}
                          aria-label={`Fewer shares for ${m.name}`}
                          onClick={() =>
                            setValues({ ...values, [m.id]: strip(Math.max(0, num(values[m.id]) - 1)) })
                          }
                        >
                          −
                        </button>
                        <span className="num" style={{ width: 22, textAlign: 'center', fontWeight: 700 }}>
                          {strip(num(values[m.id]))}
                        </span>
                        <button
                          className="icon-btn"
                          style={{ width: 30, height: 30, fontSize: 15, borderRadius: 9 }}
                          aria-label={`More shares for ${m.name}`}
                          onClick={() => setValues({ ...values, [m.id]: strip(num(values[m.id]) + 1) })}
                        >
                          +
                        </button>
                      </div>
                    </>
                  )}
                </div>
              )
            })}
          </div>
          <div className={`status-bar ${splits.ok ? (splitType === 'equal' ? '' : 'ok') : 'bad'}`}>
            <span>{splits.status}</span>
            <span className="num">{money(total)}</span>
          </div>
        </div>

        <textarea
          className="textarea"
          rows={2}
          placeholder="Notes (optional)"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />

        {error && <div className="error-text">{error}</div>}

        <button className="btn btn-primary btn-block" onClick={save} disabled={!canSave}>
          {busy ? 'Saving…' : expense ? 'Save changes' : 'Add expense'}
        </button>

        {expense &&
          (confirmDelete ? (
            <div className="row">
              <button className="btn btn-danger grow" onClick={remove} disabled={busy}>
                Yes, delete it
              </button>
              <button className="btn btn-ghost" onClick={() => setConfirmDelete(false)}>
                Keep
              </button>
            </div>
          ) : (
            <button className="btn btn-danger btn-block" onClick={() => setConfirmDelete(true)}>
              Delete expense
            </button>
          ))}
      </div>
    </Sheet>
  )
}
