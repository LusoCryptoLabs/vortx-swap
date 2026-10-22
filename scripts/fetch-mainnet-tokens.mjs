// Resolve curated TokenInfo (symbol/name/decimals/args) for mainnet xUDTs given their type hashes.
const HASHES = [
  '0x7f3fba3fb8d6e000176f7e1ae22e8cd02841dec6a8341dc69aeef46387a20664',
  '0x06ae3b6bf915242bc33a4844e9c3aa62cbed3d3fa02f7b0507ccabbf3d93468e',
  '0xfbd235ba8e5b1f8f7df6bd51e8756d52c05ef358d30e7bcfee8a73b6a9c185c9',
  '0x3cd44aecea36e0a27e671f1fc79e65add7bf2f0e8b368389dc810ec81c63fa57',
  '0x178fb47b597a56d48b549226aff59f750b4784250c7f40f781b64ef090a8a0a7',
]
const base = 'https://mainnet-api.explorer.nervos.org/api/v1/udts'
for (const h of HASHES) {
  try {
    const r = await fetch(`${base}/${h}`, { headers: { Accept: 'application/vnd.api+json', 'Content-Type': 'application/vnd.api+json' } })
    if (!r.ok) { console.log(`${h}  HTTP ${r.status}`); continue }
    const j = await r.json()
    const a = Array.isArray(j.data) ? j.data[0]?.attributes : j.data?.attributes
    if (!a) { console.log(`${h}  no data`); continue }
    const ts = a.type_script || {}
    console.log(JSON.stringify({
      symbol: (a.symbol||'').trim(), name: (a.full_name||'').trim(),
      decimals: a.decimal!=null && a.decimal!=='' ? Number(a.decimal) : 8,
      args: ts.args, codeHash: ts.code_hash, hashType: ts.hash_type, typeHash: h, icon: a.icon_file||null,
    }))
  } catch (e) { console.log(`${h}  ERR ${e.message}`) }
}
