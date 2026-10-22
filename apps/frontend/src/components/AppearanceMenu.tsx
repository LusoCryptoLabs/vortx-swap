import { Palette, Moon, Sun } from 'lucide-react'
import { Popover } from './ui/popover'
import { Button } from './ui/button'
import { Segmented } from './ui/segmented'
import { useTheme } from '../lib/theme'
import { ACCENTS, FONTS, useAppearance, type FontKey, type TextureKey } from '../lib/appearance'

/** Header "Appearance" control: the theme knobs from lib/appearance in a popover. */
export function AppearanceMenu() {
  const { ap, set } = useAppearance()
  const { theme, toggle } = useTheme()

  return (
    <Popover
      align="end"
      className="w-72"
      trigger={
        <Button variant="ghost" size="icon" aria-label="Appearance">
          <Palette className="h-4 w-4" />
        </Button>
      }
    >
      <div className="space-y-4">
        <div className="slabel"><span className="ix">A1</span><span className="tx">Brand</span><span className="ln" /></div>

        {/* Accent */}
        <div>
          <div className="mb-1.5 text-xs text-faint">Accent</div>
          <div className="flex gap-1.5">
            {ACCENTS.map(a => {
              const on = a.id === ap.accent
              return (
                <button key={a.id} title={a.name} onClick={() => set('accent', a.id)}
                  className="h-7 flex-1 rounded-lg transition-transform active:scale-95"
                  style={{
                    background: `linear-gradient(135deg, ${a.dark[0]}, ${a.dark[1]})`,
                    outline: on ? '2px solid var(--foreground)' : '1px solid color-mix(in oklab, var(--foreground) 25%, transparent)',
                    outlineOffset: on ? 1 : 0,
                  }} />
              )
            })}
          </div>
        </div>

        {/* Type */}
        <div>
          <div className="mb-1.5 text-xs text-faint">Type</div>
          <Segmented
            className="w-full justify-between"
            options={(Object.keys(FONTS) as FontKey[]).map(f => ({ value: f, label: f }))}
            value={ap.font}
            onChange={v => set('font', v as FontKey)}
          />
        </div>

        <div className="slabel"><span className="ix">A2</span><span className="tx">Surface</span><span className="ln" /></div>

        {/* Dark mode */}
        <button onClick={toggle}
          className="flex w-full items-center justify-between rounded-lg bg-surface-2 px-3 py-2 text-sm transition-colors hover:bg-surface-3">
          <span className="flex items-center gap-2">
            {theme === 'dark' ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />} Dark mode
          </span>
          <span className={`relative h-5 w-9 rounded-full transition-colors ${theme === 'dark' ? 'bg-primary' : 'bg-border'}`}>
            <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-background transition-all ${theme === 'dark' ? 'left-[1.125rem]' : 'left-0.5'}`} />
          </span>
        </button>

        {/* Roundness */}
        <div>
          <div className="mb-1.5 flex items-center justify-between text-xs text-faint">
            <span>Roundness</span><span className="num">{ap.radius.toFixed(1)}×</span>
          </div>
          <input type="range" min={0.3} max={1.5} step={0.1} value={ap.radius}
            onChange={e => set('radius', Number(e.target.value))}
            className="w-full accent-[var(--primary)]" />
        </div>

        {/* Texture */}
        <div>
          <div className="mb-1.5 text-xs text-faint">Texture</div>
          <Segmented
            className="w-full justify-between"
            options={(['Minimal', 'Subtle', 'Rich'] as TextureKey[]).map(t => ({ value: t, label: t }))}
            value={ap.texture}
            onChange={v => set('texture', v as TextureKey)}
          />
        </div>
      </div>
    </Popover>
  )
}
