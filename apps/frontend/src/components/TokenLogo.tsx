import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { sdk, config } from '../lib/cellswap'
import { fetchTokenIcon } from '../lib/tokenMeta'
import { CKB, type TokenInfo } from '../lib/tokens'
import { cn } from '../lib/utils'

// Token icon URLs come from untrusted chain/explorer metadata. Only render safe schemes: https, or a
// raster data: URI. This blocks http:// tracking beacons (and mixed content) and excludes
// data:image/svg+xml (which can carry script, even though <img> won't execute it).
const SAFE_ICON = /^(https:\/\/|data:image\/(png|jpe?g|webp|gif)[;,])/i
const safeIconUrl = (u?: string): string | undefined => (u && SAFE_ICON.test(u) ? u : undefined)

/** Resolve a token's logo: an explicit/curated icon, else the CKB Explorer (cached, size-capped).
 *  Returns undefined for CKB / tokens without a logo (caller renders the gradient avatar). */
export function useTokenIcon(token?: TokenInfo): string | undefined {
  const typeHash = token && token.args !== CKB ? sdk.udtHash(token.args as any) : undefined
  const { data } = useQuery({
    queryKey: ['token-icon', config.network, typeHash],
    enabled: !!typeHash && !token?.icon,
    staleTime: Infinity,
    queryFn: () => fetchTokenIcon(typeHash!),
  })
  return token?.icon ?? data ?? undefined
}

/** The native CKB / Nervos brand mark: the black "N" (broken diagonal) on a white roundel,
 *  rendered inline so it's always available (CKB has no fetchable token icon) and crisp at any size. */
export function CkbLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" role="img" aria-label="CKB" className={cn('shrink-0 rounded-full', className)}>
      <circle cx="16" cy="16" r="15.3" fill="#ffffff" stroke="#E3E6EA" strokeWidth="1.2" />
      {/* left bar + upper half of the diagonal */}
      <path fill="#0B0E11" d="M9 9 H13 L15.5 15 H13 V23 H9 Z" />
      {/* right bar + lower half of the diagonal (180° rotation) */}
      <path fill="#0B0E11" d="M23 23 H19 L16.5 17 H19 V9 H23 Z" />
    </svg>
  )
}

/** The Vortx brand mark for VTX: the vortex glyph (two opposing arcs + nodes, from the landing hero)
 *  on a teal→cyan roundel. Rendered inline so it's crisp at any size and independent of any external
 *  token-metadata service (VTX is protocol-native and has no fetchable logo). */
export function VtxLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" role="img" aria-label="VTX" className={cn('shrink-0 rounded-full', className)}>
      <defs>
        <linearGradient id="vtx-roundel" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="hsl(168 75% 50%)" />
          <stop offset="1" stopColor="hsl(190 82% 44%)" />
        </linearGradient>
      </defs>
      <circle cx="16" cy="16" r="15.3" fill="url(#vtx-roundel)" />
      <g fill="none" stroke="#ffffff" strokeWidth="2.4" strokeLinecap="round">
        <path d="M16 7 A5.6 5.6 0 0 1 16 16" />
        <path d="M16 25 A5.6 5.6 0 0 1 16 16" />
      </g>
      <circle cx="16" cy="7" r="1.9" fill="#ffffff" />
      <circle cx="16" cy="25" r="1.9" fill="#ffffff" />
    </svg>
  )
}

/** Token icon: real logo when available (explicit `icon`, or resolved from `token`), else a
 *  deterministic gradient avatar from the symbol. */
export function TokenLogo({ symbol, icon, token, className }: {
  symbol?: string; icon?: string; token?: TokenInfo; className?: string
}) {
  const resolved = useTokenIcon(token)
  const [broken, setBroken] = useState(false)
  const url = !broken ? safeIconUrl(icon ?? resolved) : undefined
  const sym = symbol ?? token?.symbol ?? '?'

  // Native CKB: always its brand mark (no fetchable icon, and we don't want the letter chip).
  if (!url && (token?.args === CKB || sym.toUpperCase() === 'CKB')) {
    return <CkbLogo className={className} />
  }
  // Protocol-native VTX: its inline vortex brand mark (no external logo to fetch).
  if (!url && sym.toUpperCase() === 'VTX') {
    return <VtxLogo className={className} />
  }

  if (url) {
    return <img src={url} alt={sym} onError={() => setBroken(true)}
      className={cn('shrink-0 rounded-full bg-surface-2 object-cover', className)} />
  }
  // Fallback: the Ganglia "membrane" chip, a hue-tinted cell membrane with a mono symbol.
  const hue = [...sym].reduce((a, c) => a + c.charCodeAt(0), 0) % 360
  return (
    <div
      className={cn('tchip num shrink-0 text-[0.62em] font-bold', className)}
      style={{ ['--th' as string]: hue, color: `hsl(${hue} 80% 60%)` }}
    >
      {sym.slice(0, 2)}
    </div>
  )
}

export function PairLogos({ a, b, tokenA, tokenB, className = 'h-7 w-7' }: {
  a?: string; b?: string; tokenA?: TokenInfo; tokenB?: TokenInfo; className?: string
}) {
  return (
    <div className="flex items-center">
      <TokenLogo symbol={a} token={tokenA} className={cn(className, 'z-10')} />
      <TokenLogo symbol={b} token={tokenB} className={cn(className, '-ml-2.5 ring-2 ring-surface')} />
    </div>
  )
}
