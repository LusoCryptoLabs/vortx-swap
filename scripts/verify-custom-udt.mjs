import { CellSwap } from '@cellswap/sdk'
import { getConfig } from '@cellswap/config'
const sdk = new CellSwap({ network: 'mainnet', config: getConfig('mainnet') })
const T = [
  { sym:'USDI(custom)', args:'0xd591ebdc69626647e056e13345fd830c8b876bb06aa07ba610479eb77153ea9f', codeHash:'0xbfa35a9c38a676682b65ade8f02be164d48632281477e36f8dc2f41f79e56bfc', hashType:'type', expect:'0x7f3fba3fb8d6e000176f7e1ae22e8cd02841dec6a8341dc69aeef46387a20664' },
  { sym:'ccBTC(custom)', args:'0x68e64ba4b0daeeec45c1f983d6d574fca370442cafb805bc4265ef74870a4ac8', codeHash:'0x092c2c4a26ea475a8e860c29cf00502103add677705e2ccd8d6fe5af3caa5ae3', hashType:'type', expect:'0x3cd44aecea36e0a27e671f1fc79e65add7bf2f0e8b368389dc810ec81c63fa57' },
  { sym:'DRAGON(std)', args:'0x7dc5366303a50d59003770fb9193f2db76997d8b1833e44ac41d11a1be8e7785', expect:'0x06ae3b6bf915242bc33a4844e9c3aa62cbed3d3fa02f7b0507ccabbf3d93468e' },
  { sym:'BEAF(std)', args:'0xc639759e988445217e4c08b2e7b416082d9de0cb061194e2f7f35a89bb6fbf4f', expect:'0xfbd235ba8e5b1f8f7df6bd51e8756d52c05ef358d30e7bcfee8a73b6a9c185c9' },
  { sym:'Seal(std)', args:'0x2ae639d6233f9b15545573b8e78f38ff7aa6c7bf8ef6460bf1f12d0a76c09c4e', expect:'0x178fb47b597a56d48b549226aff59f750b4784250c7f40f781b64ef090a8a0a7' },
]
let pass = 0
for (const c of T) {
  if (c.codeHash) sdk.registerUdt(c.args, c.codeHash, c.hashType)
  const got = sdk.udtHash(c.args)
  const ok = got.toLowerCase() === c.expect.toLowerCase()
  if (ok) pass++
  console.log(`${ok?'ok  ':'FAIL'} ${c.sym.padEnd(15)} ${got.slice(0,18)}… ${ok?'':'expected '+c.expect.slice(0,18)+'…'}`)
}
console.log(`\n${pass}/${T.length} type hashes match the CKB Explorer`)
