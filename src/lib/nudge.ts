import { formatMoney } from './money'
import { inviteUrl } from './router'

interface NudgeLine {
  debtor: string
  creditor: string
  amount: number // major units
}

/** Plain-text reminder suitable for WhatsApp/SMS. */
export function nudgeText(groupName: string, code: string, currency: string, lines: NudgeLine[]) {
  const body = lines.map((l) => `• ${l.debtor} → ${l.creditor}: ${formatMoney(l.amount, currency)}`).join('\n')
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
