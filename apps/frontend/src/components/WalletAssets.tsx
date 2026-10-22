import { ccc } from '@ckb-ccc/connector-react'
import { TokenLogo } from './TokenLogo'
import { RowSkeleton } from './ui/skeleton'
import { FaucetHelp } from './FaucetHelp'
import { useWalletTokens } from '../hooks/useData'
import { CKB } from '../lib/tokens'
import { fmtUnits } from '../lib/utils'

/** One wallet-balance row (logo · symbol · amount). Shared by the Header AccountMenu popover and the
 *  Wallet page so the dedicated /wallet destination isn't poorer than the popover that links to it. */
export function AssetRow({ a }: { a: any }) {
  return (
    <div className="flex items-center gap-3 px-4 py-2">
      <TokenLogo symbol={a.symbol} icon={a.icon} token={a} className="h-7 w-7" />
      <span className="flex-1 truncate text-sm font-medium">{a.symbol}</span>
      <span className="num text-sm text-muted">{fmtUnits(a.amount, a.decimals, 4)}</span>
    </div>
  )
}

/** The connected wallet's held-token list (handles loading + empty). */
export function WalletAssetList({ signer }: { signer?: ccc.Signer; emptyText?: string }) {
  const { data: assets = [], isLoading } = useWalletTokens(signer)
  if (isLoading) return <RowSkeleton rows={3} widths={['w-20', 'w-16']} />
  // The list always carries a CKB row (amount may be 0n), so the wallet is effectively "empty" when
  // it holds nothing but a zero CKB balance. Point newcomers at the faucet instead of a dead
  // "No assets" line. assets.length === 0 only happens before the first scan resolves.
  const spendable = (assets as any[]).filter(a => a.amount > 0n)
  // Empty wallet: hand off to the self-contained faucet helper (copy-your-address + numbered steps)
  // instead of a bare link, so a newcomer is never stranded asking "what is my address?".
  if (spendable.length === 0) return <div className="p-3"><FaucetHelp signer={signer} /></div>
  // Holds something, but no spendable CKB (needed for network fees): surface the same self-contained
  // faucet hand-off so the user can top up CKB without leaving the page guessing.
  const ckb = (assets as any[]).find(a => a.args?.toLowerCase() === CKB.toLowerCase())?.amount ?? 0n
  return (
    <>
      {(assets as any[]).map(a => <AssetRow key={a.args} a={a} />)}
      {ckb === 0n && (
        <div className="px-3 pb-3 pt-1">
          <p className="mb-2 px-1 text-xs text-faint">Out of CKB for network fees? Top up below.</p>
          <FaucetHelp signer={signer} />
        </div>
      )}
    </>
  )
}
