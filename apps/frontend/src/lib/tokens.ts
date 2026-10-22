// src/lib/tokens.ts: curated token lists per network.
// Token identifier = the xUDT args (owner lock hash), what the SDK keys on. CKB = zero hash.
import { create } from 'zustand'
import { NETWORK, sdk } from './cellswap'

export const CKB = ('0x' + '0'.repeat(64)) as `0x${string}`

/** The type hash the pools/pricing layer uses for native CKB (the all-zero hash, lowercased). Same
 *  value as CKB; exported as a named constant so decode/pricing sites share one source. */
export const CKB_TYPE_HASH: string = CKB

export interface TokenInfo {
  symbol: string
  name: string
  args: `0x${string}`
  decimals: number
  // Most tokens use the standard xUDT script. Tokens with their own UDT code hash (USDI, ccBTC)
  // carry it here so the SDK builds the correct type script / type hash (registered at init).
  codeHash?: `0x${string}`
  hashType?: 'type' | 'data' | 'data1'
  // Non-standard UDTs live at their own code cell. Its outpoint is here so swaps/liquidity attach the dep.
  dep?: { txHash: `0x${string}`; index: number }
  icon?: string
}

const SETS: Record<string, TokenInfo[]> = {
  devnet: [
    { symbol: 'CKB', name: 'Nervos CKB', args: CKB, decimals: 8 },
    { symbol: 'TKA', name: 'Test Token A', args: '0x7de82d61a7eb2ec82b0dc653e558ba120efcbfbb44dac87c12972d05bf250653', decimals: 8 },
    { symbol: 'TKB', name: 'Test Token B', args: '0xfefd847ee86aa34c9fe65452e233e8d389258ddf5ac7d9dbfd1b6f86007c35f0', decimals: 8 },
  ],
  testnet: [
    { symbol: 'CKB', name: 'Nervos CKB', args: CKB, decimals: 8 },
    // Demo xUDTs issued by scripts/e2e/run.mjs on testnet (identifier = owner lock hash).
    { symbol: 'TKA', name: 'CellSwap Test A', args: '0x7a71afd7508ee603c6c219c66f32408c96b5a2e66af674772ca2da27486a680d', decimals: 8 },
    { symbol: 'TKB', name: 'CellSwap Test B', args: '0x9f5f40fc2fa4b5960cdc7b71d27cbdcd74dbd684937c968b9261b837bce32fe8', decimals: 8 },
    // VTX (Vortx Token), the protocol's liquidity-mining reward. Standard xUDT whose args =
    // emission-lock hash (= sdk.vtxArgs() on testnet). Minted with a Unique cell at genesis, so
    // JoyID, CKB Explorer and other DEXes display it by name.
    { symbol: 'VTX', name: 'Vortx Token', args: '0x0f783011855d8d3f33b5ac13caa86a339a303ecd1eb24c62a9c4ecbd27674c90', decimals: 8 },
  ],
  mainnet: [
    { symbol: 'CKB', name: 'Nervos CKB', args: CKB, decimals: 8 },
    // Standard-xUDT mainnet tokens (identifier = owner lock hash). Verified via CKB Explorer.
    { symbol: 'DRAGON', name: 'DRAGON', args: '0x7dc5366303a50d59003770fb9193f2db76997d8b1833e44ac41d11a1be8e7785', decimals: 8 },
    { symbol: 'BEAF', name: 'BEAF', args: '0xc639759e988445217e4c08b2e7b416082d9de0cb061194e2f7f35a89bb6fbf4f', decimals: 0 },
    { symbol: 'Seal', name: 'Seal', args: '0x2ae639d6233f9b15545573b8e78f38ff7aa6c7bf8ef6460bf1f12d0a76c09c4e', decimals: 8 },
    { symbol: 'STB', name: 'STB', args: '0xd7b5e6117759193f963b77aa255416e080c20fa041cca521f0141e48f7904999', decimals: 8 },
    { symbol: 'CAT++', name: 'RGBCAT', args: '0x26f72274077d39aca09f75e09e41ff9daa67c1bf59d30d19e1f52d3fc226209b', decimals: 8 },
    { symbol: 'Otter', name: '@PalofSeal', args: '0x0a5c9645b871a28af6d8040ff43a8ea62a6f12a4c131c0bbdc3a20a0e46ff292', decimals: 8 },
    // iCKB (interest-bearing CKB; CKB-native Nervos-DAO wrapper): standard xUDT code hash but 36-byte args (owner hash + unique suffix).
    { symbol: 'iCKB', name: 'iCKB', args: '0xb73b6ab39d79390c6de90a09c96b290c331baf1798ed6f97aed02590929734e800000080', decimals: 8 },
    // Non-standard UDT scripts carry their own code hash (resolved by the SDK registry).
    { symbol: 'USDI', name: 'USDI', args: '0xd591ebdc69626647e056e13345fd830c8b876bb06aa07ba610479eb77153ea9f', decimals: 6,
      codeHash: '0xbfa35a9c38a676682b65ade8f02be164d48632281477e36f8dc2f41f79e56bfc', hashType: 'type',
      dep: { txHash: '0xf6a5eef65101899db9709c8de1cc28f23c1bee90d857ebe176f6647ef109e20d', index: 0 } },
    { symbol: 'RUSD', name: 'RUSD', args: '0x360c9d87b2824c357958c23e8878f686001e88e9527a08ea229e7d9ba7fe39a7', decimals: 8,
      codeHash: '0x26a33e0815888a4a0614a0b7d09fa951e0993ff21e55905510104a0b1312032b', hashType: 'type',
      dep: { txHash: '0x8ec1081bd03e5417bb4467e96f4cec841acdd35924538a35e7547fe320118977', index: 0 } },
    { symbol: 'ccBTC', name: 'ccBTC', args: '0x68e64ba4b0daeeec45c1f983d6d574fca370442cafb805bc4265ef74870a4ac8', decimals: 8,
      codeHash: '0x092c2c4a26ea475a8e860c29cf00502103add677705e2ccd8d6fe5af3caa5ae3', hashType: 'type',
      dep: { txHash: '0x3ceb520f240b168e0bddf0d89b4bcabbe7d4fa69751057cbe8e4f27239fad0e9', index: 0 } },
  ],
}

export const TOKEN_LIST: TokenInfo[] = SETS[NETWORK] ?? SETS.devnet

// Register non-standard UDT code hashes so sdk.udtHash / type-script building is correct for
// these tokens (balance lookups, pool matching, swaps). Standard xUDT tokens need no registration.
for (const t of TOKEN_LIST) if (t.codeHash) sdk.registerUdt(t.args, t.codeHash, t.hashType ?? 'type', t.dep)

/** symbol → TokenInfo */
export const TOKENS: Record<string, TokenInfo> = Object.fromEntries(TOKEN_LIST.map(t => [t.symbol, t]))

/** The native CKB TokenInfo for the current network (always present in every curated set). */
export const CKB_TOKEN: TokenInfo = TOKEN_LIST.find(t => t.args === CKB) ?? TOKEN_LIST[0]

/** The first curated non-CKB token on the current network, or CKB if the set has none. Use this
 *  instead of a hardcoded testnet symbol (e.g. TOKENS.TKA) so network-independent defaults never
 *  point at a token that does not exist on the active network. */
export function firstCuratedNonCkb(): TokenInfo {
  return TOKEN_LIST.find(t => t.args !== CKB) ?? CKB_TOKEN
}

/** Back-compat: symbol → args (used by older call sites). */
export const TOKEN_ARGS: Record<string, `0x${string}`> = Object.fromEntries(TOKEN_LIST.map(t => [t.symbol, t.args]))

export function tokenByArgs(args: string): TokenInfo | undefined {
  const a = args.toLowerCase()
  return TOKEN_LIST.find(t => t.args.toLowerCase() === a)
    ?? useCustomTokens.getState().list.find(t => t.args.toLowerCase() === a)
}

// Trust signal (display only, not a hard gate): tokens whose args are in the curated
// TOKEN_LIST render as "verified". The picker also surfaces user-imported and pool-discovered
// tokens, marked unverified, since listing and pooling are permissionless. Anti-spoofing does not
// rest on this set: every match keys on the full xUDT type hash (codeHash+hashType+args), never on
// name/symbol, so a look-alike cannot impersonate a curated token's on-chain identity.
const VERIFIED = new Set(TOKEN_LIST.map(t => t.args.toLowerCase()))
export const isVerifiedToken = (args: string) => VERIFIED.has(args.toLowerCase())

// ─── Custom (user-imported) tokens ────────────────────────────────────────
// Imported by xUDT args; persisted to localStorage; always marked unverified.
const LS_KEY = `cellswap-custom-tokens-${NETWORK}`
function loadCustom(): TokenInfo[] {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || '[]') } catch { return [] }
}

interface CustomStore {
  list: TokenInfo[]
  add: (t: TokenInfo) => void
  remove: (args: string) => void
}
export const useCustomTokens = create<CustomStore>((set, get) => ({
  list: loadCustom(),
  add: (t) => {
    if (get().list.some(x => x.args.toLowerCase() === t.args.toLowerCase()) ||
        TOKEN_LIST.some(x => x.args.toLowerCase() === t.args.toLowerCase())) return
    const list = [...get().list, t]
    localStorage.setItem(LS_KEY, JSON.stringify(list)); set({ list })
  },
  remove: (args) => {
    const list = get().list.filter(x => x.args.toLowerCase() !== args.toLowerCase())
    localStorage.setItem(LS_KEY, JSON.stringify(list)); set({ list })
  },
}))

/** Curated + user-imported tokens (non-reactive read). */
export const allTokens = (): TokenInfo[] => [...TOKEN_LIST, ...useCustomTokens.getState().list]
