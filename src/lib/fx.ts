// Live exchange rates from open.er-api.com (free, no key, CORS-enabled), cached per day in memory.
// Callers always let the user override the rate, so a failed lookup is never fatal.

const cache = new Map<string, Promise<Record<string, number>>>()

function ratesFor(base: string) {
  const key = `${base}:${new Date().toISOString().slice(0, 10)}`
  let p = cache.get(key)
  if (!p) {
    p = fetch(`https://open.er-api.com/v6/latest/${base}`)
      .then((r) => r.json())
      .then((j) => {
        if (j.result !== 'success') throw new Error('Rate lookup failed')
        return j.rates as Record<string, number>
      })
    p.catch(() => cache.delete(key))
    cache.set(key, p)
  }
  return p
}

/** How many units of `to` one unit of `from` buys, or null if unavailable. */
export async function fetchRate(from: string, to: string): Promise<number | null> {
  if (from === to) return 1
  try {
    const rate = (await ratesFor(from))[to]
    return typeof rate === 'number' && rate > 0 ? rate : null
  } catch {
    return null
  }
}

/** Rates get long decimals; keep enough precision to be useful without noise. */
export function tidyRate(rate: number) {
  return String(Number(rate.toPrecision(rate >= 1 ? 6 : 4)))
}
