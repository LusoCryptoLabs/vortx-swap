import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { useTheme } from './theme'

/** Theme knobs (accent, type, roundness, texture) applied to the document root as CSS variables
 *  and persisted to localStorage. Set from the header Appearance menu. */

export const ACCENTS = [
  { id: 'synapse', name: 'Synapse', dark: ['#14f5a0', '#2ae9ff'], light: ['#03b073', '#068fc4'] },
  { id: 'ion',     name: 'Ion',     dark: ['#4d93ff', '#2ae9ff'], light: ['#2563e6', '#068fc4'] },
  { id: 'pulse',   name: 'Pulse',   dark: ['#b98cff', '#ff6fd8'], light: ['#6d3be0', '#cc2aa0'] },
  { id: 'signal',  name: 'Signal',  dark: ['#ffc24d', '#ff6f4d'], light: ['#c47a00', '#cc3d1a'] },
] as const

export const FONTS = {
  Modern:    { display: '"Space Grotesk"',    sans: '"Hanken Grotesk"' },
  Editorial: { display: '"Instrument Serif"', sans: '"Hanken Grotesk"' },
  Geometric: { display: '"Sora"',             sans: '"Sora"' },
} as const

const TEXTURE_MAP = { Minimal: 0.25, Subtle: 1, Rich: 1.6 } as const

export type FontKey = keyof typeof FONTS
export type TextureKey = keyof typeof TEXTURE_MAP
export type Appearance = { accent: string; font: FontKey; radius: number; texture: TextureKey }

const DEFAULTS: Appearance = { accent: 'synapse', font: 'Modern', radius: 1, texture: 'Subtle' }

const Ctx = createContext<{
  ap: Appearance
  set: <K extends keyof Appearance>(k: K, v: Appearance[K]) => void
}>({ ap: DEFAULTS, set: () => {} })

export function AppearanceProvider({ children }: { children: ReactNode }) {
  const { theme } = useTheme()
  const [ap, setAp] = useState<Appearance>(() => {
    try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('vortx-appearance') || '{}') } }
    catch { return DEFAULTS }
  })

  // The accent has distinct dark/light pairs, so re-apply whenever the theme flips too.
  useEffect(() => {
    const root = document.documentElement
    const acc = ACCENTS.find(a => a.id === ap.accent) ?? ACCENTS[0]
    const [p, a] = theme === 'light' ? acc.light : acc.dark
    root.style.setProperty('--primary', p)
    root.style.setProperty('--accent', a)
    root.style.setProperty('--radius-scale', String(ap.radius))
    root.style.setProperty('--texture', String(TEXTURE_MAP[ap.texture] ?? 1))
    const f = FONTS[ap.font] ?? FONTS.Modern
    root.style.setProperty('--font-display', `${f.display}, system-ui, sans-serif`)
    root.style.setProperty('--font-sans', `${f.sans}, system-ui, sans-serif`)
    localStorage.setItem('vortx-appearance', JSON.stringify(ap))
  }, [ap, theme])

  const set = <K extends keyof Appearance>(k: K, v: Appearance[K]) =>
    setAp(prev => ({ ...prev, [k]: v }))

  return <Ctx.Provider value={{ ap, set }}>{children}</Ctx.Provider>
}

export const useAppearance = () => useContext(Ctx)
