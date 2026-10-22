import { useEffect } from 'react'
import { Link } from 'react-router-dom'
import { BrandGlyph } from '../components/Synapse'
import { usePoolViews } from '../hooks/useData'
import { realizableTvl } from '../lib/pricing'
import { compact } from '../lib/utils'

/** Marketing landing page, shown at `/`. "Launch app" enters the trading app at /swap. The
 *  ambient synapse background is mounted app-wide in App. */
export default function LandingPage() {
  const { views } = usePoolViews()
  // Use the same realizable-TVL basis as the in-app ProtocolStats (Explore/Pools), already in CKB.
  // The raw `tvlCkb` is NaN for unanchored pools.
  const tvl = views.reduce((a, v) => { const r = realizableTvl(v); return a + (isFinite(r) ? r : 0) }, 0)
  const poolCount = views.length

  // nav solidify on scroll + safe reveal-on-view (transform only; content is always visible).
  useEffect(() => {
    const lnav = document.getElementById('lnav')
    const onScroll = () => lnav?.classList.toggle('solid', window.scrollY > 12)
    window.addEventListener('scroll', onScroll); onScroll()
    const io = new IntersectionObserver(
      es => es.forEach(e => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target) } }),
      { threshold: 0.12 })
    document.querySelectorAll('.reveal').forEach(el => io.observe(el))
    return () => { window.removeEventListener('scroll', onScroll); io.disconnect() }
  }, [])

  return (
    <>
      {/* NAV */}
      <header className="lnav" id="lnav">
        <div className="wrap row">
          <Link to="/" className="flex items-center gap-2.5">
            <span className="logo-tile"><BrandGlyph size={30} color="var(--primary-foreground)" /></span>
            <span className="wordmark">Vortx<span className="gradient-text">Swap</span></span>
          </Link>
          <nav className="navlinks">
            <a href="#paths">Trade</a>
            <a href="#custody">Self-custody</a>
            <a href="#earn">Earn</a>
            <a href="#otx">How it works</a>
            <a href="#security">Security</a>
          </nav>
          <span
            title="Test network, for practice with play money, not real funds"
            className="lnav-badge inline-block rounded-lg border border-border bg-surface px-2.5 py-1 text-[11px] font-medium text-muted sm:text-xs"
          >
            Testnet: play money, not audited
          </span>
          {/* Open test round: the app itself is the action, so this goes straight there. On mobile the
              nav links above are hidden, which makes this the only header CTA. */}
          <Link className="btn btn-primary" to="/swap">Launch app →</Link>
        </div>
      </header>

      {/* HERO */}
      <section className="hero">
        <div className="wrap hero-grid">
          <div className="reveal">
            <div className="eyebrow prim">▣ Self-custody exchange · Nervos CKB</div>
            <h1 className="h1">Trade everything.<br /><span className="gradient-text">Surrender nothing.</span></h1>
            <p className="lead">Your money stays in your own wallet until you tap to approve with a passkey. There is no middleman holding it, so there is nothing to freeze, hack, or run off with.</p>
            <div className="cta-row">
              <Link className="btn btn-primary btn-lg" to="/swap">Launch app →</Link>
              <a className="btn btn-outline btn-lg" href="#otx">How it works</a>
            </div>
            <div className="trust">
              <span><span className="dotc" /> Nobody can touch your funds but you</span>
              <span><span className="dotc" /> Sign with Face ID, no seed phrase</span>
              <span><span className="dotc" /> The price you see is the price you get</span>
            </div>
          </div>

          {/* product mock */}
          <div className="product reveal">
            <svg className="scope" viewBox="0 0 240 120" fill="none" aria-hidden>
              <path d="M0 90 C30 80 50 50 80 56 C110 62 120 30 150 26 C180 22 200 44 240 18" stroke="var(--primary)" strokeWidth="2" fill="none" />
            </svg>
            <div className="panel floaty">
              <span className="panel-tick tl" /><span className="panel-tick tr" /><span className="panel-tick bl" /><span className="panel-tick br" />
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '.9rem' }}>
                <div className="slabel"><span className="ix">01</span><span className="tx">Exchange</span></div>
                <span className="badge badge-pos">Live</span>
              </div>
              {/* Mirrors the real swap card: three mode tabs (Instant/Limit/Batch) + a settings gear.
                  Batch is the custody-free OTX mode; Async stays an automatic fallback inside Instant
                  (not a tab). Keep in sync with SwapCard's MODES. */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '.6rem', marginBottom: '1rem' }}>
                <div className="seg seg-full" style={{ flex: 1 }}>
                  <button data-on="1">Instant</button><button data-on="0">Limit</button><button data-on="0">Batch</button>
                </div>
                <span aria-hidden style={{ display: 'grid', placeItems: 'center', width: 38, height: 38, borderRadius: 'var(--r-md)', background: 'var(--surface-2)', color: 'var(--faint)', flex: 'none' }}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="12" r="3.2" /><path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M18.4 5.6l-1.8 1.8M7.4 16.6l-1.8 1.8" strokeLinecap="round" /></svg>
                </span>
              </div>
              <div className="field">
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '.74rem', color: 'var(--faint)', marginBottom: '.5rem' }}><span>You pay</span><span className="num">1,240.00</span></div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span className="num" style={{ fontSize: '2rem', fontWeight: 700 }}>1,240</span>
                  <span className="pill"><span className="tchip" style={{ width: 26, height: 26, ['--th' as string]: 168 }}><svg width="19" height="19" viewBox="0 0 24 24" fill="none"><path d="M12 5 A4 4 0 0 1 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /><path d="M12 17 A4 4 0 0 1 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /><circle cx="12" cy="5" r="1.4" fill="currentColor" /><circle cx="12" cy="17" r="1.4" fill="currentColor" /></svg></span><span style={{ fontWeight: 600 }}>VTX</span></span>
                </div>
              </div>
              <div className="axon"><span className="node big-arc">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M5 12l7 7 7-7" /></svg>
              </span></div>
              <div className="field">
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '.74rem', color: 'var(--faint)', marginBottom: '.5rem' }}><span>You receive</span><span className="num">48,210.55</span></div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span className="num" style={{ fontSize: '2rem', fontWeight: 700, color: 'var(--muted)' }}>8,452.16</span>
                  <span className="pill"><span className="tchip" style={{ width: 26, height: 26, ['--th' as string]: 158 }}><svg width="19" height="19" viewBox="0 0 24 24" fill="none"><rect x="8" y="8" width="8" height="8" rx="1.8" transform="rotate(45 12 12)" fill="none" stroke="currentColor" strokeWidth="1.8" /><circle cx="12" cy="12" r="1.3" fill="currentColor" /></svg></span><span style={{ fontWeight: 600 }}>CKB</span></span>
                </div>
              </div>
              <div className="inset" style={{ marginTop: '.75rem', padding: '.7rem .8rem', display: 'flex', justifyContent: 'space-between', fontSize: '.8rem' }}>
                <span className="faint">Rate</span><span className="num">1 VTX ≈ 6.8200 CKB</span>
              </div>
              <Link className="btn btn-primary btn-lg" to="/swap" style={{ width: '100%', marginTop: '.75rem' }}>Swap</Link>
            </div>
          </div>
        </div>
      </section>

      {/* STAT BAND (real pool count + TVL when loaded) */}
      <section className="statband">
        <div className="wrap"><div className="stats">
          <div className="stat"><div className="k">{tvl > 0 ? compact(tvl) : '-'}</div><div className="l eyebrow faint">Total value locked · CKB</div></div>
          <div className="stat"><div className="k">{poolCount || '-'}</div><div className="l eyebrow faint">Live liquidity pools</div></div>
          <div className="stat"><div className="k">3</div><div className="l eyebrow faint">Ways to trade</div></div>
          <div className="stat"><div className="k prim">0</div><div className="l eyebrow faint">Times we hold your funds</div></div>
        </div></div>
      </section>

      {/* THREE PATHS */}
      <section className="sec" id="paths">
        <div className="wrap">
          <div className="sec-head reveal">
            <div className="slabel"><span className="ix">01</span><span className="tx">Three ways, one rule</span><span className="ln" /></div>
            <h2>Trade your way, and keep your funds the whole time.</h2>
            <p>Every option keeps your assets locked to your own key. The only thing that changes is the trade-off between speed and convenience.</p>
          </div>
          <div className="paths">
            <div className="panel pathcard reveal">
              <span className="panel-tick tl" /><span className="panel-tick br" />
              <span className="ic"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M13 2 3 14h9l-1 8 10-12h-9l1-8Z" /></svg></span>
              <h3>Instant</h3>
              <p>Sign once and your trade settles in about ten seconds. The simplest way to swap, and your funds never move until you approve. If the chain is busy it finishes on its own a moment later, so you can set it and forget it.</p>
            </div>
            <div className="panel pathcard reveal">
              <span className="panel-tick tl" /><span className="panel-tick br" />
              <span className="ic"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 7v5l3 2M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z" /></svg></span>
              <h3>Limit</h3>
              <p>Name the price you want and walk away. Your order rests until the market reaches it, then settles for you. Great for larger or patient trades, and your funds never leave your wallet while you wait.</p>
            </div>
            <div className="panel pathcard reveal">
              <span className="panel-tick tl" /><span className="panel-tick br" />
              <span className="badge badge-pos flag">Flagship</span>
              <span className="ic"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6l-8-3Z" /><path d="M9 12l2 2 4-4" /></svg></span>
              <h3>Batch, passkey (custody-free)</h3>
              <p>Our flagship. Many traders settle together in one batch for a better price. Your funds stay in your passkey wallet, and you are always paid at least the minimum you signed for.</p>
              <p className="num" style={{ fontSize: '.8rem', color: 'var(--faint)', marginTop: '.6rem' }}>Batch gets a better shared price for a one-time setup; Instant is faster and simpler.</p>
            </div>
          </div>
        </div>
      </section>

      {/* CUSTODY STATEMENT */}
      <section className="sec custody" id="custody">
        <div className="wrap reveal">
          <div className="slabel" style={{ justifyContent: 'center' }}><span className="ix">02</span><span className="tx">Why it's different</span></div>
          <div className="big">No one but you ever <em className="gradient-text">owns your funds.</em></div>
          <p>Plenty of exchanges call themselves non-custodial but still pass your money through a system someone controls. Vortx Swap does not. Your trade is enforced by your own wallet and by the math of the pool itself, so the worst anyone can do is ignore you. They can never take from you, overcharge you, or repeat your trade behind your back.</p>
          <p className="num" style={{ fontSize: '.82rem', color: 'var(--faint)', maxWidth: '62ch', margin: '1.1rem auto 0' }}>For the technically curious: prices are set by the constant product invariant, and settling a trade consumes your input cell, so it can never be replayed.</p>
          <div className="triplet">
            <div className="panel tc reveal"><span className="panel-tick tl" /><span className="panel-tick br" /><div className="tk">0</div><div className="eyebrow faint" style={{ marginTop: '.4rem' }}>Operators with custody</div></div>
            <div className="panel tc reveal"><span className="panel-tick tl" /><span className="panel-tick br" /><div className="tk">1</div><div className="eyebrow faint" style={{ marginTop: '.4rem' }}>Passkey to approve</div></div>
            <div className="panel tc reveal"><span className="panel-tick tl" /><span className="panel-tick br" /><div className="tk">∞</div><div className="eyebrow faint" style={{ marginTop: '.4rem' }}>Time you stay in control</div></div>
          </div>
        </div>
      </section>

      {/* EARN */}
      <section className="sec" id="earn">
        <div className="wrap">
          <div className="sec-head reveal">
            <div className="slabel"><span className="ix">03</span><span className="tx">Put your tokens to work</span><span className="ln" /></div>
            <h2>Earn while you hold.</h2>
            <p>Two ways to earn, both custody-free. Your tokens stay locked to your own key the whole time, and you can claim or withdraw whenever you like.</p>
          </div>
          <div className="paths">
            <div className="panel pathcard reveal">
              <span className="panel-tick tl" /><span className="panel-tick br" />
              <span className="ic"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M9 12l2 2 4-4" /></svg></span>
              <h3>Staking</h3>
              <p>Lock one token and earn CKB automatically, paid out every few hours and split by your share. No lock-up by default; withdraw any time (optional fixed term for a bigger share).</p>
              <Link className="btn btn-outline" to="/staking" style={{ marginTop: '1rem' }}>Open Staking →</Link>
            </div>
            <div className="panel pathcard reveal">
              <span className="panel-tick tl" /><span className="panel-tick br" />
              <span className="ic"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 4l6 6-3 3-6-6 3-3ZM11 7 3 15v6h6l8-8" /></svg></span>
              <h3>Mining</h3>
              <p>Add liquidity, then stake your pool tokens to earn VTX on top of the trading fees they already collect. Claim VTX whenever you like, or unstake to reclaim your pool tokens.</p>
              <Link className="btn btn-outline" to="/mining" style={{ marginTop: '1rem' }}>Open Mining →</Link>
            </div>
          </div>
        </div>
      </section>

      {/* HOW OTX WORKS */}
      <section className="sec" id="otx">
        <div className="wrap">
          <div className="sec-head reveal">
            <div className="slabel"><span className="ix">04</span><span className="tx">How Batch works</span><span className="ln" /></div>
            <h2>Better prices, and you still keep your funds.</h2>
            <p>Batch lets many people trade together in a single transaction. Passkey wallets cannot do this out of the box, so we built a lock that checks every trade on-chain by itself. Four steps, and your funds never leave your control.</p>
            <p className="num" style={{ fontSize: '.8rem', color: 'var(--faint)', maxWidth: '62ch', margin: '.6rem auto 0' }}>For the technically curious: this is built on open transactions (OTX), which let independent signed inputs settle in one transaction.</p>
          </div>
          <div className="steps">
            <div className="panel step reveal"><span className="panel-tick tl" /><div className="n">01</div><h4>Set up</h4><p>A one-time setup arms your passkey for batch trading. Your tokens stay in a cell only your passkey can open. It is still self-custody, never held by us or anyone else.</p></div>
            <div className="panel step reveal"><span className="panel-tick tl" /><div className="n">02</div><h4>Sign</h4><p>You approve the trade with Face ID or Touch ID. Your signature locks in the token and the minimum you will accept.</p></div>
            <div className="panel step reveal"><span className="panel-tick tl" /><div className="n">03</div><h4>Submit</h4><p>Your signed request goes to an automated relayer with no human and no custody. It can only submit the exact trade you signed, and you can pull your funds back any time.</p></div>
            <div className="panel step reveal"><span className="panel-tick tl" /><div className="n">04</div><h4>Settle</h4><p>Many traders and the pool settle together in one transaction. Your wallet checks the result and confirms you got at least your minimum.</p></div>
          </div>
          <div className="reveal" style={{ marginTop: '2.5rem', textAlign: 'center' }}>
            <Link className="btn btn-primary btn-lg" to="/swap?mode=batch">Try Batch, custody-free trading →</Link>
            <p className="num" style={{ fontSize: '.8rem', color: 'var(--faint)', marginTop: '.85rem' }}>Uses a free Face ID / fingerprint passkey, no seed phrase.</p>
          </div>
        </div>
      </section>

      {/* FEATURES */}
      <section className="sec" id="security">
        <div className="wrap">
          <div className="sec-head reveal">
            <div className="slabel"><span className="ix">05</span><span className="tx">Built honest</span><span className="ln" /></div>
            <h2>Custody-free. Predictable. Yours.</h2>
          </div>
          <div className="feats">
            {[
              ['M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6l-8-3Z', 'Nobody can touch your funds', 'No contract ever holds your money. Your own wallet is the only thing that can move it.'],
              ['M3 12h4l3 9 4-18 3 9h4', 'The price you see is the price you get', 'One tested pricing formula sets every quote, so there are no surprises and no hidden spread.'],
              ['M12 11v3a4 4 0 0 1-4 4M8 11a4 4 0 1 1 8 0v3', 'Sign with Face ID, not a seed phrase', 'Approve trades with the same passkey that unlocks your phone. Nothing to write down, nothing to lose.'],
              ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18ZM12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10Z', 'The batching service cannot cheat you', 'It can only settle trades that honor the minimum you signed. The worst it can do is skip you.'],
              ['M12 3l2.2 1.6 2.7-.2 1 2.5 2.3 1.4-1.2 5.4 1.2 5.4-2.3 1.4-1 2.5-2.7-.2L12 21', 'No fake tokens', 'We only list verified tokens, so look-alike scams can never show up in your trade.'],
              ['M12 3 2 8l10 5 10-5-10-5ZM2 14l10 5 10-5', 'Numbers straight from the chain', 'Every price and balance is read directly from Nervos CKB. There is no middle database to trust.'],
            ].map(([d, h, p], i) => (
              <div className="panel feat reveal" key={i}>
                <span className="fi"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d={d} /></svg></span>
                <h4>{h}</h4><p>{p}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* FINAL CTA */}
      <section className="finalcta">
        <div className="reveal">
          <h2>Your keys.<br /><span className="gradient-text glowtext">Your liquidity.</span></h2>
          <p>Open the app, connect a passkey, and start trading on Nervos CKB. You stay in control the whole way.</p>
          <Link className="btn btn-primary btn-lg" to="/swap">Launch Vortx Swap →</Link>
        </div>
      </section>

      {/* FOOTER */}
      <footer className="site">
        <div className="wrap row">
          <div style={{ display: 'flex', alignItems: 'center', gap: '.6rem' }}>
            <span className="logo-tile" style={{ width: 30, height: 30 }}><BrandGlyph size={25} color="var(--primary-foreground)" /></span>
            <span className="num" style={{ fontSize: '.82rem', color: 'var(--faint)' }}>Vortx Swap · self-custody exchange on Nervos CKB</span>
          </div>
          <div className="links">
            <Link to="/swap">Launch app</Link>
            <a href="#paths">Trade</a>
            <a href="#earn">Earn</a>
            <a href="#otx">How it works</a>
            <a href="#security">Security</a>
          </div>
        </div>
      </footer>
    </>
  )
}
