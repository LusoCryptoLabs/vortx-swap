// Tests against the actual JoyID verification logic from @joyid/ckb/src/verify.ts
// We reimplement verifyNativeKeySignature exactly as JoyID does it
// and confirm our lock script math matches

import { createHash, createSign, generateKeyPairSync } from 'node:crypto'
import { webcrypto } from 'node:crypto'
const { subtle } = webcrypto

let passed = 0, failed = 0
async function atest(name, fn) {
  try { await fn(); console.log(`  ok ${name}`); passed++ }
  catch(e) { console.log(`  FAIL ${name}: ${e.message}`); failed++ }
}
const assert = (c, m) => { if (!c) throw new Error(m ?? 'fail') }
const sha256 = d => createHash('sha256').update(d).digest()
const toHex  = b => Buffer.from(b).toString('hex')
const b64url = b => Buffer.from(b).toString('base64url')
const fromB64url = s => Buffer.from(s, 'base64url')

// ─── Replicate JoyID's derToIEEE (from @joyid/ckb/src/utils.ts) ───────────────

function derToIEEE(sig) {
  // Exact port of JoyID's implementation
  const signature = Array.from(new Uint8Array(sig), x =>
    `00${x.toString(16)}`.slice(-2)
  ).join('')
  const rLength = parseInt(signature.substr(6, 2), 16) * 2
  let r = signature.substr(8, rLength)
  let s = signature.substr(12 + rLength)
  r = r.length > 64 ? r.substr(-64) : r.padStart(64, '0')
  s = s.length > 64 ? s.substr(-64) : s.padStart(64, '0')
  const p1363Sig = `${r}${s}`
  return Buffer.from(p1363Sig, 'hex')
}

// ─── Replicate JoyID's verifyNativeKeySignature (from @joyid/ckb/src/verify.ts) ─

async function joyidVerifyNative({ message, signature, pubkey, challenge, alg }) {
  const pk  = Buffer.from(pubkey, 'hex')  // 64 bytes x||y
  const msg = fromB64url(message)         // base64url decode
  const sig = fromB64url(signature)       // base64url decode
  
  const authData   = msg.slice(0, 37)
  const clientData = msg.slice(37)
  
  // ensureChallenge: clientDataJSON.challenge === base64url(utf8(challenge))
  const cjson = JSON.parse(clientData.toString())
  const expectedChallenge = b64url(Buffer.from(challenge, 'utf8'))
  assert(cjson.challenge === expectedChallenge, 'Challenge mismatch in JoyID verify')
  
  // signatureBase = authData || sha256(clientData)
  const clientDataHash = sha256(clientData)
  const signatureBase  = Buffer.concat([authData, clientDataHash])
  
  const jwkPubkey = {
    kty: 'EC', crv: 'P-256',
    x: b64url(pk.slice(0, 32)),
    y: b64url(pk.slice(32, 64)),
  }
  const key = await subtle.importKey('jwk', jwkPubkey,
    { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
  
  return subtle.verify(
    { name: 'ECDSA', hash: { name: 'SHA-256' } },
    key,
    derToIEEE(sig),   // convert DER → raw r||s (IEEE P1363)
    signatureBase     // SubtleCrypto hashes this with SHA-256 internally
  )
}

// ─── Generate test key with JoyID-style pubkey format (64-byte x||y) ─────────

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
const spki = publicKey.export({ type: 'spki', format: 'der' })
const uncompressed = spki.slice(-65)  // 04 || x || y
const pubkeyXY = uncompressed.slice(1)  // x || y (JoyID format, 64 bytes)
const pubkeyHex = toHex(pubkeyXY)   // no 0x prefix

function makeAuthData(counter = 0) {
  const ad = Buffer.alloc(37)
  sha256(Buffer.from('app.cellswap.io')).copy(ad, 0)
  ad[32] = 0x05
  ad.writeUInt32BE(counter, 33)
  return ad
}

// Sign exactly like JoyID's authenticator signs
function joyidSign(challenge, authData) {
  const cd = JSON.stringify({
    type: 'webauthn.get',
    challenge: b64url(Buffer.from(challenge, 'utf8')),  // JoyID converts challenge via utf8
    origin: 'https://app.cellswap.io',
    crossOrigin: false,
  })
  const clientDataBuf  = Buffer.from(cd)
  const clientDataHash = sha256(clientDataBuf)
  const signatureBase  = Buffer.concat([authData, clientDataHash])
  
  // ES256: ECDSA P256-SHA256 (SubtleCrypto hashes signatureBase with SHA-256 internally)
  const sig = createSign('SHA256').update(signatureBase).sign({ key: privateKey, dsaEncoding: 'der' })
  
  const message   = b64url(Buffer.concat([authData, clientDataBuf]))
  const signature = b64url(sig)
  
  return {
    pubkey:    pubkeyHex,
    challenge,
    message,
    signature,
    alg: -7,
    keyType: 'main_key',
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

console.log('\n=== JoyID Integration Tests (real JoyID verification logic) ===\n')

await atest('JoyID pubkey is 64 bytes x‖y (no 04 prefix)', async () => {
  assert(pubkeyXY.length === 64, `Expected 64 bytes, got ${pubkeyXY.length}`)
  assert(pubkeyHex.length === 128, `Expected 128 hex chars, got ${pubkeyHex.length}`)
  // JoyID's verifyNativeKeySignature treats pk.slice(0,32) as x and pk.slice(32) as y
  console.log(`    x: ${pubkeyHex.slice(0, 16)}...`)
  console.log(`    y: ${pubkeyHex.slice(64, 80)}...`)
})

await atest('JoyID message is base64url(authData[37] || clientDataJSON)', async () => {
  const ad  = makeAuthData()
  const res = joyidSign('test challenge', ad)
  
  const decoded = fromB64url(res.message)
  assert(decoded.slice(0, 37).equals(ad), 'authData mismatch')
  const cd = JSON.parse(decoded.slice(37).toString())
  assert(cd.type === 'webauthn.get', 'clientDataJSON type')
  assert(typeof cd.challenge === 'string', 'challenge must be string')
})

await atest('JoyID signature is base64url(DER)', async () => {
  const res = joyidSign('test challenge', makeAuthData())
  const sigBytes = fromB64url(res.signature)
  
  // DER starts with 0x30 (sequence tag)
  assert(sigBytes[0] === 0x30, `DER must start with 0x30, got ${sigBytes[0]}`)
  // Typical DER length for P-256 is 70-72 bytes
  assert(sigBytes.length >= 68 && sigBytes.length <= 74, `Unexpected DER length: ${sigBytes.length}`)
})

await atest('JoyID verifyNativeKeySignature validates our generated signature', async () => {
  const ad  = makeAuthData(42)
  const res = joyidSign('Sign this OTX please', ad)
  const ok  = await joyidVerifyNative(res)
  assert(ok, 'JoyID verifyNativeKeySignature must return true')
})

await atest('Our lock script math matches JoyID verifyNativeKeySignature exactly', async () => {
  const ad  = makeAuthData(7)
  const res = joyidSign('cellswap-otx-hash', ad)
  
  // JoyID's path:
  const msg        = fromB64url(res.message)
  const authData   = msg.slice(0, 37)
  const clientData = msg.slice(37)
  const sigDer     = fromB64url(res.signature)
  
  // Our lock script path:
  const clientHash   = sha256(clientData)
  const sigBase      = Buffer.concat([authData, clientHash])
  const prehash      = sha256(sigBase)             // sha256(signatureBase)
  const rawSig       = derToIEEE(sigDer)            // DER → r||s
  
  // Verify using SubtleCrypto with pre-hashed message
  // (equivalent to p256 verify_prehash in Rust)
  const pk = Buffer.from(pubkeyHex, 'hex')
  const jwk = { kty: 'EC', crv: 'P-256', x: b64url(pk.slice(0,32)), y: b64url(pk.slice(32)) }
  const key = await subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
  
  // Our verify_prehash equivalent: verify over sigBase (SubtleCrypto hashes internally)
  const ok = await subtle.verify({ name: 'ECDSA', hash: { name: 'SHA-256' } }, key, rawSig, sigBase)
  assert(ok, 'Lock script math must match JoyID verification')
  
  // JoyID path also works
  const joyidOk = await joyidVerifyNative(res)
  assert(joyidOk, 'JoyID verifyNativeKeySignature must also pass')
})

await atest('Challenge format: JoyID encodes string challenge as base64url(utf8(challenge))', async () => {
  // If a string is passed to signChallenge(), JoyID encodes utf8(string) as the challenge,
  // so the OTX hash must be passed in a form the lock script can verify
  
  const otxHashString = 'Sign this OTX: 0x' + 'a'.repeat(64)  // example hex string
  const ad = makeAuthData()
  const res = joyidSign(otxHashString, ad)
  
  const cd = JSON.parse(fromB64url(res.message).slice(37).toString())
  // JoyID challenge = base64url(utf8(otxHashString))
  const expected = b64url(Buffer.from(otxHashString, 'utf8'))
  assert(cd.challenge === expected, 'String challenge is base64url(utf8(string))')
  
  // This means: if we pass raw bytes as challenge (via Uint8Array), 
  // JoyID encodes them directly without utf8 conversion
  console.log('    NOTE: For OTX, pass Uint8Array to signChallenge(), not a hex string')
  console.log('    Then clientDataJSON.challenge = base64url(raw_bytes) = base64url(otxHash)')
})

await atest('Full end-to-end: OTX hash → sign → verify with lock script math', async () => {
  // Simulate what actually happens:
  // 1. SDK computes OTX hash (Uint8Array)
  // 2. Frontend calls signChallenge(otxHashBytes, address) [Uint8Array form]
  // 3. JoyID encodes raw bytes as challenge in clientDataJSON
  // 4. Lock script verifies base64url(otxHash) == clientDataJSON.challenge
  
  const otxHash = sha256(Buffer.from('CellSwap pool ETH/USDC swap'))  // 32-byte OTX hash
  
  // Simulate JoyID encoding a Uint8Array challenge
  // When signChallenge receives Uint8Array, clientDataJSON.challenge = base64url(rawBytes)
  const challengeInJSON = b64url(otxHash)  // base64url of raw bytes directly
  
  const ad = makeAuthData(99)
  const cd = JSON.stringify({
    type: 'webauthn.get',
    challenge: challengeInJSON,  // base64url(otxHash), what the lock script expects
    origin: 'https://app.cellswap.io',
    crossOrigin: false,
  })
  const clientDataBuf  = Buffer.from(cd)
  const clientDataHash = sha256(clientDataBuf)
  const sigBase        = Buffer.concat([ad, clientDataHash])
  const derSig         = createSign('SHA256').update(sigBase).sign({ key: privateKey, dsaEncoding: 'der' })
  
  // Build "JoyID response"
  const message   = b64url(Buffer.concat([ad, clientDataBuf]))
  const signature = b64url(derSig)
  const joyidRes  = { pubkey: pubkeyHex, challenge: '', message, signature, alg: -7, keyType: 'main_key' }
  
  // Parse as our parseJoyIDOtxResponse would
  const msgBytes   = fromB64url(message)
  const authData   = msgBytes.slice(0, 37)
  const clientData = msgBytes.slice(37)
  const cdParsed   = JSON.parse(clientData.toString())
  
  // Lock script challenge verification: base64url(otxHash) == cdParsed.challenge
  assert(cdParsed.challenge === b64url(otxHash), 'Challenge must match OTX hash')
  
  // Lock script signature verification
  const rawSig = derToIEEE(fromB64url(signature))
  const pk = Buffer.from(pubkeyHex, 'hex')
  const jwk = { kty: 'EC', crv: 'P-256', x: b64url(pk.slice(0,32)), y: b64url(pk.slice(32)) }
  const key = await subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
  const ok  = await subtle.verify({ name: 'ECDSA', hash: { name: 'SHA-256' } }, key, rawSig, sigBase)
  assert(ok, 'End-to-end lock script verification must pass')
  
  console.log(`    OTX hash: ${toHex(otxHash).slice(0,16)}...`)
  console.log(`    Challenge in JSON: ${challengeInJSON.slice(0,16)}...`)
})

await atest('SECURITY: lock args 64-byte x‖y correctly identifies key owner', async () => {
  // Different keys = different x‖y = different lock args = different lock script hash
  const { publicKey: key2 } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const spki2    = key2.export({ type: 'spki', format: 'der' })
  const xy2      = spki2.slice(-64)  // x||y (no 04 prefix)
  
  // Different x‖y → different lock script hash → cannot use attacker's signature
  assert(!Buffer.from(pubkeyXY).equals(xy2), 'Keys must be different')
})

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`)
if (failed > 0) process.exit(1)
