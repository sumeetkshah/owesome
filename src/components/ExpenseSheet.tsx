import { useEffect, useRef, useState } from 'react'
import {
  api,
  type Expense,
  type ExpenseKind,
  type GroupData,
  type ItemLine,
  type Member,
  type SplitType,
} from '../lib/api'
import { allCategories, customKey } from '../lib/categories'
import { today } from '../lib/format'
import { fetchRate, tidyRate } from '../lib/fx'
import { allocate, allocateSigned, CURRENCIES, currencySymbol, formatMoney, fromMinor, toMinor } from '../lib/money'
import { isPdf, receiptUrl, uploadReceipt } from '../lib/receipts'
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
  equal: 'Equal',
  exact: 'Exact',
  percent: '%',
  shares: 'Shares',
  itemized: 'Items',
}

interface ItemDraft {
  key: number
  name: string
  amount: string
  members: string[]
}

const num = (s: string | undefined) => {
  const n = parseFloat(s ?? '')
  return Number.isFinite(n) && n > 0 ? n : 0
}
const strip = (n: number) => String(Math.round(n * 100) / 100)
const cleanAmount = (v: string) => v.replace(/[^0-9.]/g, '').replace(/(\..*?)\..*/, '$1')

let itemKey = 0

export default function ExpenseSheet({ code, data, me, expense, onClose, onSaved }: Props) {
  const { members, group } = data
  const groupCur = group.currency
  const foreignAtLoad = !!expense?.currency && expense.currency !== groupCur

  const [kind, setKind] = useState<ExpenseKind>(expense?.kind ?? 'expense')
  const [cur, setCur] = useState(expense?.currency ?? groupCur)
  const [rate, setRate] = useState(expense && foreignAtLoad ? tidyRate(expense.fx_rate) : '1')
  const [rateNote, setRateNote] = useState(foreignAtLoad ? 'rate used when saved' : '')

  const [amount, setAmount] = useState(() =>
    expense ? strip(foreignAtLoad ? (expense.original_amount ?? expense.amount) : expense.amount) : '',
  )
  const [description, setDescription] = useState(expense?.description ?? '')
  const [category, setCategory] = useState(expense?.category ?? 'food')
  const [spentOn, setSpentOn] = useState(expense?.spent_on ?? today())
  const [notes, setNotes] = useState(expense?.notes ?? '')

  const [multiPayer, setMultiPayer] = useState((expense?.payers.length ?? 1) > 1)
  const [payer, setPayer] = useState(expense?.payers[0]?.member_id ?? me)
  const [payerAmounts, setPayerAmounts] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      expense?.payers.map((p) => [p.member_id, strip(foreignAtLoad ? (p.original_amount ?? p.amount) : p.amount)]) ?? [],
    ),
  )

  const [splitType, setSplitType] = useState<SplitType>(expense?.split_type ?? 'equal')
  const [included, setIncluded] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(members.map((m) => [m.id, expense ? expense.splits.some((s) => s.member_id === m.id) : true])),
  )
  const [values, setValues] = useState<Record<string, string>>(() => {
    if (!expense || expense.split_type === 'equal' || expense.split_type === 'itemized') return {}
    return Object.fromEntries(
      expense.splits.map((s) => [
        s.member_id,
        strip(expense.split_type === 'exact' ? (foreignAtLoad ? (s.weight ?? s.amount) : s.amount) : (s.weight ?? 0)),
      ]),
    )
  })

  const meta = expense?.meta
  const [items, setItems] = useState<ItemDraft[]>(() =>
    meta?.items?.length
      ? meta.items.map((i) => ({ key: itemKey++, name: i.name, amount: strip(i.amount), members: i.members }))
      : [{ key: itemKey++, name: '', amount: '', members: members.map((m) => m.id) }],
  )
  const [taxPct, setTaxPct] = useState(meta?.tax_pct ? strip(meta.tax_pct) : '')
  const [servicePct, setServicePct] = useState(meta?.service_pct ? strip(meta.service_pct) : '')
  const [tip, setTip] = useState(meta?.tip ? strip(meta.tip) : '')
  const [discount, setDiscount] = useState(meta?.discount ? strip(meta.discount) : '')

  const [receipts, setReceipts] = useState<string[]>(expense?.receipts ?? [])
  const [uploading, setUploading] = useState(false)

  const [newCat, setNewCat] = useState<{ name: string; emoji: string } | null>(null)
  const [customCats, setCustomCats] = useState(data.categories)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)

  const foreign = cur !== groupCur
  const rateNum = foreign ? num(rate) : 1
  const money = (minor: number, c = cur) => formatMoney(fromMinor(minor), c, { decimals: minor % 100 !== 0 })
  const label = (m: Member) => (m.id === me ? 'You' : m.name)

  // Look up a live rate whenever the currency changes (unless reopening an expense with its saved rate).
  const lastCur = useRef(cur)
  useEffect(() => {
    if (lastCur.current === cur) return
    lastCur.current = cur
    if (!foreign) return
    let stale = false
    fetchRate(cur, groupCur).then((r) => {
      if (stale) return
      if (r) {
        setRate(tidyRate(r))
        setRateNote('live rate · edit if your bank charged differently')
      } else {
        setRate('')
        setRateNote('couldn’t fetch a rate — enter it manually')
      }
    })
    return () => {
      stale = true
    }
  }, [cur, groupCur, foreign])

  /* ---------- itemised bill ---------- */
  const bill = (() => {
    const perPerson = new Map(members.map((m) => [m.id, 0]))
    let subtotal = 0
    let problem = ''
    for (const it of items) {
      const v = toMinor(num(it.amount))
      if (!v) continue
      if (!it.members.length) problem = `Pick who had “${it.name || 'an item'}”`
      subtotal += v
      allocate(v, it.members.map(() => 1)).forEach((share, i) =>
        perPerson.set(it.members[i], (perPerson.get(it.members[i]) ?? 0) + share),
      )
    }
    const pct = num(taxPct) + num(servicePct)
    const extras = Math.round((subtotal * pct) / 100) + toMinor(num(tip)) - toMinor(num(discount))
    const ids = members.map((m) => m.id)
    const base = ids.map((id) => perPerson.get(id) ?? 0)
    const extraShares = allocateSigned(extras, base)
    const totals = Object.fromEntries(ids.map((id, i) => [id, base[i] + extraShares[i]]))
    if (!subtotal && !problem) problem = 'Add at least one item with a price'
    if (subtotal + extras <= 0 && !problem) problem = 'The discount is larger than the bill'
    return { subtotal, extras, total: subtotal + extras, totals, problem }
  })()

  const total = splitType === 'itemized' ? Math.max(0, bill.total) : toMinor(num(amount))

  /* ---------- payers (in expense currency) ---------- */
  const payers = (() => {
    if (!multiPayer) return { list: [{ member_id: payer, minor: total }], error: undefined as string | undefined }
    const list = members
      .map((m) => ({ member_id: m.id, minor: toMinor(num(payerAmounts[m.id])) }))
      .filter((p) => p.minor > 0)
    const diff = total - list.reduce((a, p) => a + p.minor, 0)
    return {
      list,
      error: diff === 0 ? undefined : diff > 0 ? `${money(diff)} still to assign` : `${money(-diff)} over the total`,
    }
  })()

  /* ---------- splits (in expense currency) ---------- */
  const splits = (() => {
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
    } else if (splitType === 'itemized') {
      list = ids
        .map((id) => ({ member_id: id, minor: bill.totals[id] ?? 0, weight: null }))
        .filter((s) => s.minor > 0)
      ok = !bill.problem
      status = bill.problem || `${list.length} ${list.length === 1 ? 'person' : 'people'} · from items`
    } else {
      const weights = ids.map((id) => num(values[id]))
      const parts = allocate(total, weights)
      list = ids
        .map((id, i) => ({ member_id: id, minor: parts[i], weight: weights[i] as number | null }))
        .filter((s) => (s.weight ?? 0) > 0)
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
    return { list, preview: Object.fromEntries(list.map((s) => [s.member_id, s.minor])), status, ok }
  })()

  // Everything above is in the expense's currency; convert to the group currency for balances.
  const groupTotal = Math.round(total * rateNum)

  const canSave =
    total > 0 && description.trim() && !payers.error && splits.ok && rateNum > 0 && !busy && !uploading

  const changeCurrency = (c: string) => {
    if (c !== groupCur) setRateNote('fetching live rate…')
    setCur(c)
  }

  const switchSplit = (t: SplitType) => {
    setSplitType(t)
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

  const addReceipts = async (files: FileList | null) => {
    if (!files?.length) return
    setUploading(true)
    setError('')
    try {
      for (const f of Array.from(files)) {
        const path = await uploadReceipt(code, f)
        setReceipts((r) => [...r, path])
      }
    } catch (e) {
      setError(`Upload failed: ${(e as Error).message}`)
    } finally {
      setUploading(false)
    }
  }

  const save = async () => {
    setBusy(true)
    setError('')
    try {
      const payerGroup = allocate(groupTotal, payers.list.map((p) => p.minor))
      const splitGroup = allocate(groupTotal, splits.list.map((s) => s.minor))
      const itemLines: ItemLine[] = items
        .filter((i) => num(i.amount) > 0)
        .map((i) => ({ name: i.name.trim() || 'Item', amount: num(i.amount), members: i.members }))

      await api.saveExpense(code, {
        id: expense?.id,
        kind,
        description: description.trim(),
        amount: fromMinor(groupTotal),
        currency: cur,
        fx_rate: rateNum,
        original_amount: fromMinor(total),
        category,
        split_type: splitType,
        spent_on: spentOn,
        notes: notes.trim() || undefined,
        created_by: expense ? undefined : me,
        receipts,
        meta:
          splitType === 'itemized'
            ? { items: itemLines, tax_pct: num(taxPct), service_pct: num(servicePct), tip: num(tip), discount: num(discount) }
            : undefined,
        payers: payers.list.map((p, i) => ({
          member_id: p.member_id,
          amount: fromMinor(payerGroup[i]),
          original_amount: fromMinor(p.minor),
        })),
        splits: splits.list.map((s, i) => ({
          member_id: s.member_id,
          amount: fromMinor(splitGroup[i]),
          // For foreign exact splits keep the entered amount so the expense reopens as typed.
          weight: splitType === 'exact' ? (foreign ? fromMinor(s.minor) : null) : s.weight,
        })),
      })
      toast(expense ? 'Saved' : kind === 'refund' ? 'Refund added' : 'Expense added')
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
      toast('Deleted')
      onSaved()
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }

  const isRefund = kind === 'refund'

  return (
    <Sheet title={expense ? (isRefund ? 'Edit refund' : 'Edit expense') : isRefund ? 'Add refund' : 'Add expense'} onClose={onClose}>
      <div className="segmented" style={{ marginTop: 4 }}>
        <button className={!isRefund ? 'on' : ''} onClick={() => setKind('expense')}>
          💸 Expense
        </button>
        <button className={isRefund ? 'on' : ''} onClick={() => setKind('refund')}>
          ↩️ Refund / income
        </button>
      </div>

      <div className="amount-input">
        <select className="cur-select" value={cur} onChange={(e) => changeCurrency(e.target.value)} aria-label="Currency">
          {[...new Set([groupCur, ...CURRENCIES])].map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <span className="sym">{currencySymbol(cur)}</span>
        {splitType === 'itemized' ? (
          <span className="amount-static num">{strip(fromMinor(total))}</span>
        ) : (
          <input
            inputMode="decimal"
            placeholder="0"
            value={amount}
            autoFocus={!expense}
            aria-label="Amount"
            style={{ width: `${Math.max(amount.length, 1) + 0.6}ch` }}
            onChange={(e) => setAmount(cleanAmount(e.target.value))}
          />
        )}
      </div>
      {splitType === 'itemized' && <div className="faint center small">Total is worked out from the items below</div>}

      {foreign && (
        <div className="fx-row">
          <span className="muted">1 {cur} =</span>
          <input
            className="input input-sm num"
            inputMode="decimal"
            value={rate}
            aria-label="Exchange rate"
            onChange={(e) => {
              setRate(cleanAmount(e.target.value))
              setRateNote('your rate')
            }}
          />
          <span className="muted">{groupCur}</span>
          <span className="grow" />
          <strong className="num">≈ {money(groupTotal, groupCur)}</strong>
          {rateNote && <div className="faint small" style={{ width: '100%' }}>{rateNote}</div>}
        </div>
      )}

      <div className="stack" style={{ gap: 20, marginTop: 14 }}>
        <input
          className="input"
          placeholder={isRefund ? 'What was refunded? e.g. Hotel deposit' : 'What was it for?'}
          value={description}
          maxLength={120}
          onChange={(e) => setDescription(e.target.value)}
        />

        <div className="field">
          <span className="label">category</span>
          <div className="chips">
            {allCategories(customCats).map((c) => (
              <button key={c.key} className={`chip ${category === c.key ? 'on' : ''}`} onClick={() => setCategory(c.key)}>
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
            <span className="label">{isRefund ? 'received by' : 'paid by'}</span>
            <label className="row" style={{ gap: 8, fontSize: 13 }}>
              <span className="muted">{isRefund ? 'Multiple people' : 'Multiple payers'}</span>
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
                <button key={m.id} className={`chip ${payer === m.id ? 'on' : ''}`} onClick={() => setPayer(m.id)}>
                  <Avatar member={m} size="sm" /> {label(m)}
                </button>
              ))}
            </div>
          ) : (
            <div>
              {members.map((m) => (
                <div key={m.id} className="split-row">
                  <Avatar member={m} size="sm" />
                  <span className="name ellipsis">{label(m)}</span>
                  <input
                    className="input input-sm value num"
                    inputMode="decimal"
                    placeholder="0"
                    value={payerAmounts[m.id] ?? ''}
                    onChange={(e) => setPayerAmounts({ ...payerAmounts, [m.id]: cleanAmount(e.target.value) })}
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
          <span className="label">{isRefund ? 'goes back to' : 'split'}</span>
          <div className="segmented" role="tablist">
            {(Object.keys(SPLIT_LABELS) as SplitType[]).map((t) => (
              <button key={t} role="tab" aria-selected={splitType === t} className={splitType === t ? 'on' : ''} onClick={() => switchSplit(t)}>
                {SPLIT_LABELS[t]}
              </button>
            ))}
          </div>

          {splitType === 'itemized' && (
            <ItemsEditor
              items={items}
              setItems={setItems}
              members={members}
              me={me}
              cur={cur}
              taxPct={taxPct}
              setTaxPct={setTaxPct}
              servicePct={servicePct}
              setServicePct={setServicePct}
              tip={tip}
              setTip={setTip}
              discount={discount}
              setDiscount={setDiscount}
              subtotal={bill.subtotal}
              extras={bill.extras}
            />
          )}

          <div>
            {members.map((m) => {
              const share = splits.preview[m.id] ?? 0
              if (splitType === 'itemized' && !share) return null
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
                  <span className="name ellipsis">{label(m)}</span>

                  {(splitType === 'equal' || splitType === 'itemized') && (
                    <span className={`num ${share ? '' : 'faint'}`}>{money(share)}</span>
                  )}

                  {splitType === 'exact' && (
                    <input
                      className="input input-sm value num"
                      inputMode="decimal"
                      placeholder="0"
                      value={values[m.id] ?? ''}
                      onChange={(e) => setValues({ ...values, [m.id]: cleanAmount(e.target.value) })}
                    />
                  )}

                  {splitType === 'percent' && (
                    <>
                      <span className="faint num small">{money(share)}</span>
                      <div className="row" style={{ gap: 4, width: 84 }}>
                        <input
                          className="input input-sm num"
                          inputMode="decimal"
                          placeholder="0"
                          style={{ textAlign: 'right' }}
                          value={values[m.id] ?? ''}
                          onChange={(e) => setValues({ ...values, [m.id]: cleanAmount(e.target.value) })}
                        />
                        <span className="faint">%</span>
                      </div>
                    </>
                  )}

                  {splitType === 'shares' && (
                    <>
                      <span className="faint num small">{money(share)}</span>
                      <div className="row" style={{ gap: 6 }}>
                        <button
                          className="icon-btn stepper"
                          aria-label={`Fewer shares for ${m.name}`}
                          onClick={() => setValues({ ...values, [m.id]: strip(Math.max(0, num(values[m.id]) - 1)) })}
                        >
                          −
                        </button>
                        <span className="num" style={{ width: 22, textAlign: 'center', fontWeight: 700 }}>
                          {strip(num(values[m.id]))}
                        </span>
                        <button
                          className="icon-btn stepper"
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

        <hr className="divider" />

        <div className="field">
          <span className="label">receipts</span>
          <div className="receipts">
            {receipts.map((r) => (
              <div key={r} className="receipt-thumb">
                <a href={receiptUrl(r)} target="_blank" rel="noreferrer" aria-label="Open receipt">
                  {isPdf(r) ? <span className="pdf">PDF</span> : <img src={receiptUrl(r)} alt="Receipt" />}
                </a>
                <button className="receipt-x" aria-label="Remove receipt" onClick={() => setReceipts(receipts.filter((x) => x !== r))}>
                  ✕
                </button>
              </div>
            ))}
            <label className={`receipt-add ${uploading ? 'busy' : ''}`}>
              <input
                type="file"
                accept="image/*,application/pdf"
                multiple
                hidden
                disabled={uploading}
                onChange={(e) => {
                  addReceipts(e.target.files)
                  e.target.value = ''
                }}
              />
              <span>{uploading ? '…' : '📎'}</span>
              <span className="small">{uploading ? 'Uploading' : 'Add'}</span>
            </label>
          </div>
        </div>

        <textarea className="textarea" rows={2} placeholder="Notes (optional)" value={notes} onChange={(e) => setNotes(e.target.value)} />

        {error && <div className="error-text">{error}</div>}

        <button className="btn btn-primary btn-block" onClick={save} disabled={!canSave}>
          {busy ? 'Saving…' : expense ? 'Save changes' : isRefund ? 'Add refund' : 'Add expense'}
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
              Delete
            </button>
          ))}
      </div>
    </Sheet>
  )
}

/* ------------------------------------------------------------------ */

interface ItemsEditorProps {
  items: ItemDraft[]
  setItems: (fn: (items: ItemDraft[]) => ItemDraft[]) => void
  members: Member[]
  me: string
  cur: string
  taxPct: string
  setTaxPct: (v: string) => void
  servicePct: string
  setServicePct: (v: string) => void
  tip: string
  setTip: (v: string) => void
  discount: string
  setDiscount: (v: string) => void
  subtotal: number
  extras: number
}

function ItemsEditor(p: ItemsEditorProps) {
  const money = (minor: number) => formatMoney(fromMinor(minor), p.cur, { decimals: minor % 100 !== 0 })
  const update = (key: number, patch: Partial<ItemDraft>) =>
    p.setItems((items) => items.map((i) => (i.key === key ? { ...i, ...patch } : i)))
  const allIds = p.members.map((m) => m.id)

  return (
    <div className="stack" style={{ gap: 10, marginTop: 4 }}>
      {p.items.map((it, idx) => (
        <div key={it.key} className="item-card">
          <div className="row" style={{ gap: 8 }}>
            <input
              className="input input-sm"
              placeholder={`Item ${idx + 1}`}
              value={it.name}
              maxLength={60}
              onChange={(e) => update(it.key, { name: e.target.value })}
            />
            <input
              className="input input-sm num"
              style={{ width: 96, textAlign: 'right', flex: 'none' }}
              inputMode="decimal"
              placeholder="0"
              value={it.amount}
              aria-label="Item price"
              onChange={(e) => update(it.key, { amount: cleanAmount(e.target.value) })}
            />
            <button
              className="link faint-link"
              aria-label="Remove item"
              onClick={() => p.setItems((items) => (items.length > 1 ? items.filter((i) => i.key !== it.key) : items))}
            >
              ✕
            </button>
          </div>
          <div className="chips" style={{ gap: 6, marginTop: 8 }}>
            <button
              className={`chip chip-xs ${it.members.length === allIds.length ? 'on' : ''}`}
              onClick={() => update(it.key, { members: it.members.length === allIds.length ? [] : allIds })}
            >
              Everyone
            </button>
            {p.members.map((m) => {
              const on = it.members.includes(m.id)
              return (
                <button
                  key={m.id}
                  className={`chip chip-xs ${on ? 'on' : ''}`}
                  onClick={() =>
                    update(it.key, { members: on ? it.members.filter((x) => x !== m.id) : [...it.members, m.id] })
                  }
                >
                  {m.id === p.me ? 'You' : m.name}
                </button>
              )
            })}
          </div>
        </div>
      ))}
      <button
        className="btn btn-ghost btn-sm"
        onClick={() => p.setItems((items) => [...items, { key: itemKey++, name: '', amount: '', members: allIds }])}
      >
        + Add item
      </button>

      <div className="extras-grid">
        <label className="field">
          <span className="label">tax / gst %</span>
          <input className="input input-sm num" inputMode="decimal" placeholder="0" value={p.taxPct} onChange={(e) => p.setTaxPct(cleanAmount(e.target.value))} />
        </label>
        <label className="field">
          <span className="label">service %</span>
          <input className="input input-sm num" inputMode="decimal" placeholder="0" value={p.servicePct} onChange={(e) => p.setServicePct(cleanAmount(e.target.value))} />
        </label>
        <label className="field">
          <span className="label">tip / other</span>
          <input className="input input-sm num" inputMode="decimal" placeholder="0" value={p.tip} onChange={(e) => p.setTip(cleanAmount(e.target.value))} />
        </label>
        <label className="field">
          <span className="label">discount</span>
          <input className="input input-sm num" inputMode="decimal" placeholder="0" value={p.discount} onChange={(e) => p.setDiscount(cleanAmount(e.target.value))} />
        </label>
      </div>
      <div className="row between small muted">
        <span>
          Items {money(p.subtotal)} {p.extras >= 0 ? '+' : '−'} extras {money(Math.abs(p.extras))}
        </span>
        <span className="faint">extras split in proportion</span>
      </div>
    </div>
  )
}
