import { formatMoney } from './money'
import { inviteUrl } from './router'

export const UPI_PATTERN = /^[A-Za-z0-9._-]{2,128}@[A-Za-z0-9.-]{2,64}$/

/** A `upi://pay` deep link; opens GPay/PhonePe/Paytm etc. on phones with the amount prefilled. */
export function upiLink(opts: { vpa: string; name: string; amount: number; note: string }) {
  const params = new URLSearchParams({
    pa: opts.vpa,
    pn: opts.name,
    am: opts.amount.toFixed(2),
    cu: 'INR',
    tn: opts.note.slice(0, 50),
  })
  return `upi://pay?${params.toString()}`
}

interface NudgeLine {
  debtor: string
  creditor: string
  amount: number // major units
  upi?: string | null
}

/** Plain-text reminder suitable for WhatsApp/SMS. */
export function nudgeText(groupName: string, code: string, currency: string, lines: NudgeLine[]) {
  const body = lines
    .map((l) => {
      const amt = formatMoney(l.amount, currency)
      const pay = currency === 'INR' && l.upi ? ` (UPI: ${l.upi})` : ''
      return `• ${l.debtor} → ${l.creditor}: ${amt}${pay}`
    })
    .join('\n')
  return `Hey! Quick reminder to settle up for “${groupName}” 🙏\n\n${body}\n\nSee the details: ${inviteUrl(code)}`
}

/** Opens the share sheet where available (mobile), otherwise WhatsApp Web. */
export async function sendNudge(text: string) {
  if (navigator.share) {
    try {
      await navigator.share({ text })
      return
    } catch (e) {
      if ((e as DOMException).name === 'AbortError') return
    }
  }
  window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank', 'noopener')
}
