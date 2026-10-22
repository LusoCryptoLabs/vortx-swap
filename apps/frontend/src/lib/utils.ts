import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/** Merge Tailwind classes with conflict resolution. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** Compact number formatting for stats (1.23K, 4.5M). */
export function compact(n: number, digits = 2): string {
  if (!isFinite(n)) return '-'
  return new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: digits }).format(n)
}

const SUBS = '₀₁₂₃₄₅₆₇₈₉'
const subscript = (z: number) => String(z).split('').map(d => SUBS[+d]).join('')

/** Tiny positive price → subscript-zero decimal (the Uniswap/DexScreener style): 0.0000123 →
 *  "0.0₄123". Distinct and compact for sub-0.0001 prices, and not scientific notation. */
function fmtTiny(n: number, sig = 3): string {
  let exp = Math.floor(Math.log10(n))
  let mant = Number((n / 10 ** exp).toFixed(sig))
  if (mant >= 10) { mant /= 10; exp += 1 }          // rounding can push 9.999→10
  const zeros = Math.max(0, -exp - 1)
  const digits = mant.toFixed(sig).replace('.', '').replace(/0+$/, '') || '0'
  return `0.0${subscript(zeros)}${digits}`
}

/** Human-friendly price, never in scientific notation. Big → compact (659M, 159.14K); normal →
 *  significant digits with separators (0.82942, 1,250); tiny → subscript-zero (0.0₄123). */
export function fmtPrice(n: number | null | undefined, sig = 5): string {
  if (n == null || !isFinite(n) || n <= 0) return '-'
  if (n >= 1e4) return compact(n)
  if (n >= 1e-4) return Number(n.toPrecision(sig)).toLocaleString('en', { maximumSignificantDigits: sig })
  return fmtTiny(n)
}

/** Format a token amount (bigint base units) to a human string with `decimals`. */
export function fmtUnits(amount: bigint | number, decimals = 8, maxFrac = 6): string {
  // Coerce defensively: a number slipping in here would make `a / d` (number / bigint)
  // throw "Cannot mix BigInt and other types".
  const amt = typeof amount === 'bigint' ? amount : BigInt(Math.trunc(Number(amount) || 0))
  const neg = amt < 0n
  let a = neg ? -amt : amt
  const d = BigInt(10) ** BigInt(decimals)
  const whole = a / d
  const frac = a % d
  let fracStr = frac.toString().padStart(decimals, '0').slice(0, maxFrac).replace(/0+$/, '')
  const wholeStr = whole.toLocaleString('en')
  return (neg ? '-' : '') + (fracStr ? `${wholeStr}.${fracStr}` : wholeStr)
}

/** Parse a decimal string into base units (bigint) at `decimals`. */
export function parseUnits(s: string, decimals = 8): bigint | null {
  if (!s) return null
  const m = s.replace(/,/g, '').match(/^(\d*)(?:\.(\d*))?$/)
  if (!m) return null
  const whole = m[1] || '0'
  const frac = (m[2] || '').slice(0, decimals).padEnd(decimals, '0')
  try { return BigInt(whole) * BigInt(10) ** BigInt(decimals) + BigInt(frac || '0') } catch { return null }
}

export const shortHash = (h: string, n = 6) => (h.length > 2 * n + 2 ? `${h.slice(0, n + 2)}…${h.slice(-n)}` : h)

/** Read a little-endian u128 (an xUDT amount) from the first 16 bytes of a hex string (0x optional).
 *  The one shared decoder for cell data; keeps the LE byte order from drifting between call sites. */
export function readU128LE(hex: string): bigint {
  const h = (hex.startsWith('0x') ? hex.slice(2) : hex).slice(0, 32)
  const bytes = h.match(/.{2}/g)
  return bytes && bytes.length ? BigInt('0x' + bytes.reverse().join('')) : 0n
}

/** The shared "no value yet" placeholder. Use it instead of ad hoc values such as '???' so
 *  adjacent rows render consistently. */
export const EMPTY = '-'

/** CKB epochs are ~4h. Turn a deadline epoch + tip epoch into an approximate ETA: days remaining,
 *  an approximate unlock date, and whether it has already matured. */
const EPOCH_HOURS = 4
export function epochEta(deadlineEpoch: bigint, tipEpoch: bigint): { days: number; date: Date; matured: boolean } {
  const diff = Number(deadlineEpoch - tipEpoch)
  const hours = Math.max(0, diff) * EPOCH_HOURS
  return { days: Math.ceil(hours / 24), date: new Date(Date.now() + hours * 3_600_000), matured: diff <= 0 }
}

/** "Jun 14": short, approximate unlock date (epochs aren't exact clock time). */
export const fmtDate = (d: Date) => d.toLocaleDateString('en', { month: 'short', day: 'numeric' })
