import { forwardRef, type ButtonHTMLAttributes } from 'react'
import { cn } from '../../lib/utils'

type Variant = 'primary' | 'secondary' | 'ghost' | 'outline'
type Size = 'sm' | 'md' | 'lg' | 'icon'

const variants: Record<Variant, string> = {
  primary:
    'bg-primary text-primary-foreground hover:brightness-110 shadow-[0_8px_30px_-12px_var(--primary)] disabled:opacity-40 disabled:shadow-none',
  secondary: 'bg-surface-2 text-foreground hover:bg-border/60',
  ghost: 'text-muted hover:text-foreground hover:bg-surface-2',
  outline: 'border border-border text-foreground hover:bg-surface-2',
}
const sizes: Record<Size, string> = {
  sm: 'h-8 px-3 text-sm rounded-lg',
  md: 'h-10 px-4 text-sm rounded-xl',
  lg: 'h-14 px-6 text-base rounded-2xl',
  // 44px touch target: icon buttons are the header theme/settings toggles, which are easy to mis-tap.
  icon: 'h-11 w-11 rounded-xl',
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: Size
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'primary', size = 'md', ...props }, ref) => (
    <button
      ref={ref}
      className={cn(
        'inline-flex items-center justify-center gap-2 font-medium transition-all active:scale-[0.985] disabled:cursor-not-allowed select-none',
        variants[variant], sizes[size], className,
      )}
      {...props}
    />
  ),
)
Button.displayName = 'Button'
