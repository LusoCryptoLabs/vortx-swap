import { useNavigate } from 'react-router-dom'
import { ccc } from '@ckb-ccc/connector-react'
import { ChevronDown, Copy, ExternalLink, Send, QrCode, LogOut } from 'lucide-react'
import { toast } from 'sonner'
import { Popover } from './ui/popover'
import { Button } from './ui/button'
import { WalletAssetList } from './WalletAssets'
import { explorerAddr } from '../lib/explorer'
import { NETWORK } from '../lib/cellswap'
import { shortHash } from '../lib/utils'

export function AccountMenu({ address }: { address: string }) {
  const { disconnect } = ccc.useCcc()
  const signer = ccc.useSigner()
  const navigate = useNavigate()

  return (
    <Popover
      align="end"
      className="w-80 p-0"
      trigger={
        <Button variant="secondary" className="gap-2">
          <span className="h-2 w-2 rounded-full bg-positive shadow-[0_0_8px_var(--positive)]" />
          <span className="num text-sm">{shortHash(address, 4)}</span>
          <ChevronDown className="h-4 w-4 text-faint" />
        </Button>
      }
    >
      {/* address row */}
      <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
        <span className="num text-sm" title="Your wallet address: share it with anyone to receive funds">{shortHash(address, 6)}</span>
        <div className="flex items-center gap-1">
          <button onClick={() => { navigator.clipboard.writeText(address); toast.success('Address copied') }}
            className="rounded-lg p-1.5 text-faint hover:text-foreground" title="Copy">
            <Copy className="h-4 w-4" />
          </button>
          <a href={explorerAddr(address)} target="_blank" rel="noreferrer"
            className="rounded-lg p-1.5 text-faint hover:text-foreground" title="Explorer">
            <ExternalLink className="h-4 w-4" />
          </a>
        </div>
      </div>

      {/* assets */}
      <div className="max-h-64 overflow-y-auto py-1">
        <div className="px-4 pb-1 pt-2 text-xs text-faint" title={NETWORK === 'testnet' ? 'Test network, for practice, not real money' : undefined}>
          Assets · {NETWORK === 'testnet' ? 'test network' : NETWORK}
        </div>
        <WalletAssetList signer={signer ?? undefined} />
      </div>

      {/* actions */}
      <div className="grid grid-cols-2 gap-2 border-t border-border p-3">
        <Button variant="secondary" size="sm" onClick={() => navigate('/wallet')}><Send className="h-4 w-4" /> Send</Button>
        <Button variant="secondary" size="sm" onClick={() => navigate('/wallet?mode=receive')}><QrCode className="h-4 w-4" /> Receive</Button>
        {/* Disconnect reads as destructive (red on hover). The caption and tooltip make clear it
            only signs you out on this device; the wallet and funds are untouched. */}
        <div className="col-span-2 mt-1">
          <button
            onClick={() => { disconnect(); navigate('/') }}
            title="Signs you out on this device. Your wallet and funds are unaffected."
            className="flex w-full items-center justify-center gap-2 rounded-lg py-2 text-sm text-faint hover:text-negative"
          >
            <LogOut className="h-4 w-4" /> Disconnect
          </button>
          <p className="px-2 pb-1 text-center text-[11px] leading-tight text-faint">
            Signs you out on this device. Your wallet and funds are unaffected.
          </p>
        </div>
      </div>
    </Popover>
  )
}
