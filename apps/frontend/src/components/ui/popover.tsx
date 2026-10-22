import * as PopoverPrimitive from '@radix-ui/react-popover'
import { type ReactNode } from 'react'
import { cn } from '../../lib/utils'

export function Popover({
  trigger, children, align = 'end', className,
}: {
  trigger: ReactNode
  children: ReactNode
  align?: 'start' | 'center' | 'end'
  className?: string
}) {
  return (
    <PopoverPrimitive.Root>
      <PopoverPrimitive.Trigger asChild>{trigger}</PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align={align}
          sideOffset={8}
          className={cn('card z-50 w-72 p-4 shadow-2xl focus:outline-none', className)}
        >
          {children}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  )
}
