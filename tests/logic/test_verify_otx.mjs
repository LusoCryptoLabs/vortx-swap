import { createHash, createSign, generateKeyPairSync } from 'node:crypto'
import { webcrypto } from 'node:crypto'
const { subtle } = webcrypto

let pass=0, fail=0
async function check(n, fn){ try{ await fn(); console.log(`  ok ${n}`); pass++ }catch(e){ console.log(`  FAIL ${n}: ${e.message}`); fail++ } }
const assert=(c,m)=>{ if(!c) throw new Error(m) }
const sha256=d=>new Uint8Array(createHash('sha256').update(d).digest())
const b64url=b=>Buffer.from(b).toString('base64url')
const { blake2b } = await import('@noble/hashes/blake2b').catch(()=>import(new URL('../../packages/sdk/node_modules/@noble/hashes/blake2b.js', import.meta.url)))
const PERS=new Uint8Array([0x63,0x6b,0x62,0x2d,0x63,0x73,0x77,0x70,0x2d,0x6f,0x74,0x78,0x63,0x6f,0x6d,0x00])
const CKBPERS=new Uint8Array([0x63,0x6b,0x62,0x2d,0x64,0x65,0x66,0x61,0x75,0x6c,0x74,0x2d,0x68,0x61,0x73,0x68])
const ckbHash=d=>Buffer.from(blake2b.create({personalization:CKBPERS,dkLen:32}).update(d).digest())
const u128=v=>{const b=new Uint8Array(16);let n=v;for(let i=0;i<16;i++){b[i]=Number(n&0xffn);n>>=8n}return b}
const u64=v=>{const b=new Uint8Array(8);let n=v;for(let i=0;i<8;i++){b[i]=Number(n&0xffn);n>>=8n}return b}
const u32=v=>{const b=new Uint8Array(4);new DataView(b.buffer).setUint32(0,v,true);return b}
const cat=(...a)=>{const t=a.reduce((s,x)=>s+x.length,0);const r=new Uint8Array(t);let o=0;for(const x of a){r.set(x,o);o+=x.length}return r}
const hb=h=>{h=h.replace(/^0x/,'');const r=new Uint8Array(h.length/2);for(let i=0;i<r.length;i++)r[i]=parseInt(h.slice(i*2,i*2+2),16);return r}
const tx=b=>Array.from(b).map(x=>x.toString(16).padStart(2,'0')).join('')

// Replicate the aggregator's verifyOtxPayload core (commitment + sig + intent match)
// preimage = outpoint(36)||amt(16)||minOut(16)||tokenOut(32)||owner(32)||tokenIn(32)||deadline(8)
function commitment(txHash,index,amt,minOut,tokenOut,owner,tokenIn,deadline){
  const h=blake2b.create({personalization:PERS,dkLen:32})
  h.update(cat(hb(txHash),u32(index)))
  h.update(u128(amt)); h.update(u128(minOut)); h.update(hb(tokenOut)); h.update(hb(owner))
  h.update(hb(tokenIn)); h.update(u64(deadline))
  return Buffer.from(h.digest())
}

const {privateKey,publicKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'})
const pubXY=publicKey.export({type:'spki',format:'der'}).slice(-64)

function buildPayload({minOut=95000n, tamperIntent=false, tamperTokenIn=false}={}){
  const txHash='0x'+'11'.repeat(32), index=0, amt=100000n
  const tokenOut='0x'+'bb'.repeat(32), owner='0x'+'cc'.repeat(32)
  const tokenInHash='0x'+'aa'.repeat(32), deadline=12345n
  const com=commitment(txHash,index,amt,minOut,tokenOut,owner,tokenInHash,deadline)
  const ad=Buffer.alloc(37); sha256(Buffer.from('app.cellswap.io')).forEach((b,i)=>ad[i]=b); ad[32]=5; ad.writeUInt32BE(1,33)
  const cd=Buffer.from(JSON.stringify({type:'webauthn.get',challenge:b64url(com),origin:'https://app.cellswap.io',crossOrigin:false}))
  const sigBase=cat(ad,sha256(cd))
  const der=createSign('SHA256').update(sigBase).sign({key:privateKey,dsaEncoding:'der'})
  // derToRaw (proper)
  let off=2; if(der[off]!==0x02)throw new Error('r tag'); const rLen=der[off+1]; let r=der.slice(off+2,off+2+rLen); off=off+2+rLen
  if(der[off]!==0x02)throw new Error('s tag'); const sLen=der[off+1]; let s=der.slice(off+2,off+2+sLen)
  r=r[0]===0?r.slice(1):r; s=s[0]===0?s.slice(1):s
  const raw=new Uint8Array(64); raw.set(r.slice(-32),32-Math.min(r.length,32)); raw.set(s.slice(-32),64-Math.min(s.length,32))
  // intent in witness (120 bytes), optionally tampered to mismatch declared
  const wIntentMinOut = tamperIntent ? 1n : minOut
  const wTokenIn = tamperTokenIn ? hb('0x'+'ee'.repeat(32)) : hb(tokenInHash)
  const intent=cat(u128(wIntentMinOut),hb(tokenOut),hb(owner),wTokenIn,u64(deadline))
  const w=cat(raw,pubXY,u32(ad.length),new Uint8Array(ad),u32(cd.length),new Uint8Array(cd),intent)
  return {
    inputCells:[{txHash,index}], lockArgs:('0x01'+tx(ckbHash(pubXY))), witness:('0x'+tx(w)),
    tokenIn:'0x'+'aa'.repeat(32), tokenInTypeHash:tokenInHash, amountIn:amt, tokenOut,
    minAmountOut:minOut, ownerLockHash:owner, deadlineEpoch:deadline,
    ownerLock:{codeHash:'0x'+'00'.repeat(32),hashType:'type',args:'0x'},
  }
}

// Import the real verifier the aggregator runs (built dist), so a regression in verifyOtxPayload
// fails this suite instead of a mirrored copy silently drifting from it.
const { verifyOtxPayload: verify } = await import('../../packages/aggregator/dist/verify-otx.js')

console.log('\n=== Aggregator OTX Verification ===\n')
await check('accepts a valid signed payload', async()=>{ const r=await verify(buildPayload()); assert(r.ok, r.reason) })
await check('rejects tampered intent (witness minOut != declared)', async()=>{ const r=await verify(buildPayload({tamperIntent:true})); assert(!r.ok && /minAmountOut/i.test(r.reason), 'should reject: '+r.reason) })
await check('rejects substituted input token (witness tokenIn != declared)', async()=>{ const r=await verify(buildPayload({tamperTokenIn:true})); assert(!r.ok && /tokenIn/i.test(r.reason), 'should reject: '+r.reason) })
await check('rejects wrong-length lockArgs', async()=>{ const p=buildPayload(); p.lockArgs='0xdead'; const r=await verify(p); assert(!r.ok, 'should reject') })
await check('rejects mismatched declared minOut (breaks commitment)', async()=>{ const p=buildPayload(); p.minAmountOut=1n; const r=await verify(p); assert(!r.ok, 'should reject') })

console.log(`\n=== Results: ${pass} passed, ${fail} failed ===\n`)
if(fail>0) process.exit(1)
