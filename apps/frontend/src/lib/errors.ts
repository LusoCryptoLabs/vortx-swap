// src/lib/errors.ts: turn raw contract / aggregator / SDK errors into plain-English copy a
// non-technical user can act on, and never leave them fearing their money moved on a failure.
// Falls back to a trimmed raw message when we do not recognize the error.

/** Append this to any failure toast: a failed on-chain tx never moves funds. */
export const FUNDS_SAFE_NOTE = 'Your funds stayed in your wallet. A failed transaction never moves anything.'

const RULES: { test: RegExp; msg: string }[] = [
  { test: /no route|no pool|routed-hop|only ckb-routed/i, msg: 'There is no trading route for this pair right now. Try a smaller amount or a different token.' },
  { test: /insufficient|not enough|capacity|balance/i, msg: 'Not enough balance to cover the amount plus the small network fee. Top up and try again.' },
  { test: /slippage|min.?out|price moved|rentnotrefunded|exceeds|too little/i, msg: 'The price moved more than your limit, so the trade was cancelled to protect you. Try again, or raise your max price change.' },
  { test: /aggregator|relay|settlement|offline|failed to fetch|networkerror|timeout|econn/i, msg: 'The settlement service did not respond. Your funds are untouched. Please try again in a moment.' },
  { test: /reject|declin|user denied|cancelled by user|abort/i, msg: 'You declined the request in your wallet, so nothing was sent.' },
  { test: /passkey|joyid/i, msg: 'This step needs a passkey wallet (JoyID). Connect one and try again.' },
  { test: /invalid address|address.*invalid|fromstring/i, msg: 'That recipient address does not look valid. Double-check it and try again.' },
]

/** Map a thrown error to a short, human, actionable message. */
export function humanizeError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e ?? '')
  for (const r of RULES) if (r.test.test(raw)) return r.msg
  const trimmed = raw.replace(/\s+/g, ' ').trim()
  return trimmed ? trimmed.slice(0, 140) : 'Something went wrong. Your funds are safe.'
}
