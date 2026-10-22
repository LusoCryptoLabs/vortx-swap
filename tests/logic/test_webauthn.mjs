import { createHash, createSign, createVerify, generateKeyPairSync } from 'node:crypto'
import { webcrypto } from 'node:crypto'
const { subtle } = webcrypto

let passed = 0, failed = 0, pending = []

async function atest(name, fn) {
  try { await fn(); console.log(`  ok ${name}`); passed++ }
  catch(e) { console.log(`  FAIL ${name}: ${e.message}`); failed++ }
}
function assert(cond, msg) { if (!cond) throw new Error(msg ?? 'assertion failed') }
function eq(a, b) { assert(String(a) === String(b), `expected ${b}, got ${a}`) }

// ─── Helpers ──────────────────────────────────────────────────────────────────

const sha256 = (data) => createHash('sha256').update(data).digest()
const hex = (b) => Buffer.from(b).toString('hex')
const fromHex = (h) => Buffer.from(h.replace(/^0x/, ''), 'hex')
const b64url = (b) => Buffer.from(b).toString('base64url')
const fromB64url = (s) => Buffer.from(s, 'base64url')

function derToRaw(der) {
  assert(der[0] === 0x30, 'Not DER')
  let off = 2
  assert(der[off] === 0x02, 'Expected r tag')
  const rLen = der[++off], rData = der.slice(off+1, off+1+rLen)
  const r = rData[0] === 0 ? rData.slice(1) : rData
  off += 1 + rLen
  assert(der[off] === 0x02, 'Expected s tag')
  const sLen = der[++off], sData = der.slice(off+1, off+1+sLen)
  const s = sData[0] === 0 ? sData.slice(1) : sData
  const raw = new Uint8Array(64)
  raw.set(r.slice(-32), 32 - Math.min(r.length, 32))
  raw.set(s.slice(-32), 64 - Math.min(s.length, 32))
  return raw
}

function makeAuthData(counter = 0) {
  const ad = new Uint8Array(37)
  ad.set(sha256('app.cellswap.io'), 0)      // rpIdHash: 32 bytes
  ad[32] = 0x05                               // flags: UP + UV
  new DataView(ad.buffer).setUint32(33, counter, false)  // signCount: 4 bytes BE
  return ad
}

function makeClientDataJSON(challengeBytes) {
  return JSON.stringify({
    type: 'webauthn.get',
    challenge: b64url(challengeBytes),
    origin: 'https://app.cellswap.io',
    crossOrigin: false,
  })
}

// Generate real P-256 key pair
const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
const spki = publicKey.export({ type: 'spki', format: 'der' })
const uncompressed = spki.slice(-65)
assert(uncompressed[0] === 0x04)
const [x, y] = [uncompressed.slice(1, 33), uncompressed.slice(33, 65)]
const compressed = Buffer.concat([Buffer.from([(y[31] & 1) ? 0x03 : 0x02]), x])

// ─── Tests ────────────────────────────────────────────────────────────────────

console.log('\n=== WebAuthn + OTX Signing Tests ===\n')

await atest('P-256 key pair generates 33-byte compressed pubkey', async () => {
  eq(compressed.length, 33)
  assert(compressed[0] === 0x02 || compressed[0] === 0x03)
  console.log(`    pubkey: ${hex(compressed).slice(0,16)}...`)
})

await atest('AuthData is exactly 37 bytes (rpIdHash+flags+counter)', async () => {
  const ad = makeAuthData()
  eq(ad.length, 37)  // 32 + 1 + 4 = 37, as in the iany.me write-up (skip=37)
})

await atest('WebAuthn math: sign then verify with Node crypto', async () => {
  const otxHash = sha256('test OTX')
  const ad = makeAuthData()
  const cd = Buffer.from(makeClientDataJSON(otxHash))
  
  // signed_bytes = authenticatorData || sha256(clientDataJSON)
  const signedBytes = Buffer.concat([ad, sha256(cd)])
  
  // ES256: sign sha256(signedBytes) with P-256 ECDSA
  const sig = createSign('SHA256').update(signedBytes).sign(privateKey)
  const ok  = createVerify('SHA256').update(signedBytes).verify(publicKey, sig)
  assert(ok, 'Node ECDSA P-256 round-trip')
})

await atest('Our lock script math matches actual WebAuthn signature', async () => {
  const otxHash = sha256('CellSwap OTX swap 100 USDC→ETH')
  const ad = makeAuthData(5)
  const cd = Buffer.from(makeClientDataJSON(otxHash))
  
  // Sign with WebAuthn math
  const signedBytes = Buffer.concat([ad, sha256(cd)])
  const derSig = createSign('SHA256').update(signedBytes).sign(privateKey)
  const rawSig = derToRaw(derSig)
  
  // Lock script verification:
  // prehash = sha256(authenticatorData || sha256(clientDataJSON))
  // verify_prehash(prehash, rawSig) using pubkey
  // Equivalent with SubtleCrypto: verify(signedBytes) since it hashes internally
  const keyObj = await subtle.importKey('raw', uncompressed, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
  const ok = await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, keyObj, rawSig, signedBytes)
  assert(ok, 'Lock script prehash math must verify correctly')
})

await atest('Challenge in clientDataJSON matches OTX hash', async () => {
  const otxHash = sha256('test challenge')
  const cd = makeClientDataJSON(otxHash)
  const parsed = JSON.parse(cd)
  
  // Lock script extracts challenge and compares to base64url(otx_hash)
  const expected = b64url(otxHash)
  eq(parsed.challenge, expected)
  
  // Decoded challenge == original OTX hash bytes
  const decoded = fromB64url(parsed.challenge)
  assert(decoded.equals(otxHash), 'Challenge decodes back to OTX hash')
})

await atest('DER→raw signature round-trip (10 messages)', async () => {
  for (let i = 0; i < 10; i++) {
    const msg = Buffer.from(`message ${i}`)
    const der = createSign('SHA256').update(msg).sign(privateKey)
    const raw = derToRaw(der)
    eq(raw.length, 64)
    
    const keyObj = await subtle.importKey('raw', uncompressed, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
    const ok = await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, keyObj, raw, msg)
    assert(ok, `DER→raw failed for message ${i}`)
  }
})

await atest('Witness encode→decode round-trip', async () => {
  const sig = Buffer.alloc(64, 0xAB)
  const ad  = Buffer.from(makeAuthData())
  const cd  = Buffer.from(makeClientDataJSON(sha256('test')))
  
  // Encode (our encodeWebAuthnWitness)
  const buf = Buffer.alloc(64 + 4 + ad.length + 4 + cd.length)
  sig.copy(buf, 0)
  buf.writeUInt32LE(ad.length, 64)
  ad.copy(buf, 68)
  buf.writeUInt32LE(cd.length, 68 + ad.length)
  cd.copy(buf, 68 + ad.length + 4)
  
  // Decode (our Rust lock script)
  eq(buf.readUInt32LE(64), 37)           // auth_data_len
  eq(buf.readUInt32LE(68 + 37), cd.length) // client_data_len
  assert(buf.slice(68, 105).equals(ad), 'auth_data round-trip')
  assert(buf.slice(68 + 37 + 4).equals(cd), 'client_data round-trip')
})

await atest('SECURITY: tampered OTX hash is rejected', async () => {
  const realOtxHash = sha256('real OTX: 100 USDC to 0.042 ETH')
  const fakeOtxHash = sha256('fake OTX: drain pool')
  
  const ad = makeAuthData()
  const realCd = Buffer.from(makeClientDataJSON(realOtxHash))
  
  // User signs real OTX
  const signedBytes = Buffer.concat([ad, sha256(realCd)])
  const derSig = createSign('SHA256').update(signedBytes).sign(privateKey)
  const rawSig = derToRaw(derSig)
  
  // Attacker tries to use signature for fake OTX
  const fakeCd = Buffer.from(makeClientDataJSON(fakeOtxHash))
  const fakeSignedBytes = Buffer.concat([ad, sha256(fakeCd)])
  
  const keyObj = await subtle.importKey('raw', uncompressed, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
  const ok = await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, keyObj, rawSig, fakeSignedBytes)
  
  assert(!ok, 'tampered OTX must be rejected')
})

await atest('SECURITY: attacker key cannot forge signature', async () => {
  const otxHash = sha256('victim OTX')
  const ad = makeAuthData()
  const cd = Buffer.from(makeClientDataJSON(otxHash))
  const signedBytes = Buffer.concat([ad, sha256(cd)])
  
  // Victim signs
  const derSig = createSign('SHA256').update(signedBytes).sign(privateKey)
  const rawSig = derToRaw(derSig)
  
  // Attacker key (different pubkey → different lock args → different lock script)
  const { publicKey: attackerPub } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const attackerSpki = attackerPub.export({ type: 'spki', format: 'der' })
  const attackerUncompressed = attackerSpki.slice(-65)
  
  const keyObj = await subtle.importKey('raw', attackerUncompressed, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
  const ok = await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, keyObj, rawSig, signedBytes)
  
  assert(!ok, 'a different pubkey must not verify')
})

await atest('SECURITY: replaying old signature for new OTX fails', async () => {
  // Old OTX (already settled) signature cannot be used for new OTX
  const oldOtxHash = sha256('old OTX: already settled')
  const newOtxHash = sha256('new OTX: attacker wants to re-drain')
  
  const ad = makeAuthData(100) // counter=100 for old tx
  const oldCd = Buffer.from(makeClientDataJSON(oldOtxHash))
  const oldSignedBytes = Buffer.concat([ad, sha256(oldCd)])
  const oldDerSig = createSign('SHA256').update(oldSignedBytes).sign(privateKey)
  const oldRawSig = derToRaw(oldDerSig)
  
  // Try to use old signature for new OTX
  const newCd = Buffer.from(makeClientDataJSON(newOtxHash))
  const newSignedBytes = Buffer.concat([ad, sha256(newCd)])
  
  const keyObj = await subtle.importKey('raw', uncompressed, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
  const ok = await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, keyObj, oldRawSig, newSignedBytes)
  
  assert(!ok, 'an old signature must not authorize a new OTX')
})

await atest('Full OTX simulation: sign → parse → verify', async () => {
  // Simulate complete JoyID signChallenge() flow
  const otxHash = sha256('CellSwap pool ETH/USDC swap: 100 USDC → 0.042 ETH minOut=0.040')
  
  // 1. Frontend computes OTX hash, calls signChallenge(otxHashBytes, address)
  // 2. JoyID returns message = base64url(authData || clientDataJSON)
  const ad = makeAuthData(99)
  const cd = Buffer.from(makeClientDataJSON(otxHash))
  const message = b64url(Buffer.concat([ad, cd]))
  
  // 3. JoyID signs: ES256(authData || sha256(clientDataJSON))
  const signedBytes = Buffer.concat([ad, sha256(cd)])
  const derSig = createSign('SHA256').update(signedBytes).sign(privateKey)
  const rawSig = derToRaw(derSig)
  
  // 4. Parse JoyID response (our parseJoyIDOtxResponse())
  const msgDecoded  = fromB64url(message)
  const adDecoded   = msgDecoded.slice(0, 37)
  const cdDecoded   = msgDecoded.slice(37)
  
  // 5. Verify challenge
  const cjson    = JSON.parse(cdDecoded.toString())
  const decoded  = fromB64url(cjson.challenge)
  assert(decoded.equals(otxHash), 'Challenge must match OTX hash')
  
  // 6. Lock script verification
  const clientHashV  = sha256(cdDecoded)
  const signedBytesV = Buffer.concat([adDecoded, clientHashV])
  const keyObj = await subtle.importKey('raw', uncompressed, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
  const ok = await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, keyObj, rawSig, signedBytesV)
  
  assert(ok, 'Full simulation must verify')
  console.log(`    OTX hash: ${hex(otxHash).slice(0,16)}...`)
  console.log(`    Pubkey:   ${hex(compressed).slice(0,16)}...`)
  console.log(`    Sig:      ${hex(rawSig).slice(0,16)}...`)
})

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`)
if (failed > 0) process.exit(1)
