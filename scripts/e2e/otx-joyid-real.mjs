// otx-joyid-real.mjs: verify a real JoyID signChallenge() response end to end.
//
// Why this exists
// Every automated OTX test (run.mjs step 13, otx-testnet.mjs) signs with a locally generated
// prime256v1 key and hand-builds clientDataJSON/authenticatorData (makeSimulatedJoyID). That checks
// the math, but not that JoyID's real authenticator encodes the challenge exactly as the lock and the
// aggregator expect (base64url of the raw commitment bytes, unpadded). A wallet can't run in CI, so
// this is a manual scaffold: capture one real response in the browser, drop it in a JSON file, and run
// this to confirm the built verifier (verifyOtxPayload) accepts it.
//
// How to capture (once, in the app with a real JoyID account)
//   1. Build the OTX commitment for a real swap:  computeSwapCommitment(intent)  (@cellswap/sdk)
//   2. Call JoyID:  signChallenge(commitmentBytes, address)   // pass the Uint8Array, not a hex string
//   3. Save the SwapIntent params and the JoyID response together as JSON, e.g.:
//        {
//          "intent": {
//            "firstInputTxHash": "0x...", "firstInputIndex": 0, "totalInputAmount": "100000",
//            "minAmountOut": "95000", "tokenOut": "0x..(32B)..", "ownerLockHash": "0x..(32B)..",
//            "tokenInTypeHash": "0x..(32B)..", "deadlineEpoch": "0"
//          },
//          "joyid": { "pubkey": "..(128 hex)..", "challenge": "..", "message": "..b64url..",
//                     "signature": "..b64url..", "alg": -7, "keyType": "main_key" },
//          "tokenIn": "0x..(xUDT args)..",
//          "ownerLock": { "codeHash": "0x..", "hashType": "type", "args": "0x.." }
//        }
//   4. Run:  JOYID_CAPTURE=path/to/capture.json node scripts/e2e/otx-joyid-real.mjs
//
// Without JOYID_CAPTURE set this exits 0 (nothing to verify) so it is safe to leave in a suite.

import { readFileSync } from 'node:fs'
import { parseJoyIDOtxResponse } from '@cellswap/sdk'
import { verifyOtxPayload } from '../../packages/aggregator/dist/verify-otx.js'

const capturePath = process.env.JOYID_CAPTURE
if (!capturePath) {
  console.log('[otx-joyid-real] SKIP: no JOYID_CAPTURE set (manual step, see the header of this file).')
  process.exit(0)
}

const raw = JSON.parse(readFileSync(capturePath, 'utf8'))
const intent = {
  firstInputTxHash: raw.intent.firstInputTxHash,
  firstInputIndex:  Number(raw.intent.firstInputIndex),
  totalInputAmount: BigInt(raw.intent.totalInputAmount),
  minAmountOut:     BigInt(raw.intent.minAmountOut),
  tokenOut:         raw.intent.tokenOut,
  ownerLockHash:    raw.intent.ownerLockHash,
  tokenInTypeHash:  raw.intent.tokenInTypeHash,
  deadlineEpoch:    BigInt(raw.intent.deadlineEpoch),
}

const { witness, lockArgs } = await parseJoyIDOtxResponse(raw.joyid, intent)

const payload = {
  inputCells:      [{ txHash: intent.firstInputTxHash, index: intent.firstInputIndex }],
  lockArgs,
  witness,
  tokenIn:         raw.tokenIn,
  tokenInTypeHash: intent.tokenInTypeHash,
  amountIn:        intent.totalInputAmount,
  tokenOut:        intent.tokenOut,
  minAmountOut:    intent.minAmountOut,
  ownerLockHash:   intent.ownerLockHash,
  deadlineEpoch:   intent.deadlineEpoch,
  ownerLock:       raw.ownerLock,
}

const result = await verifyOtxPayload(payload)
if (result.ok) {
  console.log('[otx-joyid-real] PASS: real JoyID response accepted by verifyOtxPayload.')
  process.exit(0)
} else {
  console.error(`[otx-joyid-real] FAIL: verifyOtxPayload rejected the real response: ${result.reason}`)
  console.error('  A rejection here means JoyID encodes the challenge differently than the lock expects.')
  process.exit(1)
}
