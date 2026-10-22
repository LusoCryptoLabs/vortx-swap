import * as DialogPrimitive from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { type ReactNode } from 'react'
import { cn } from '../../lib/utils'

export function Dialog({
  open, onOpenChange, title, children, className,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  title?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm data-[state=open]:animate-in data-[state=open]:fade-in" />
        <DialogPrimitive.Content
          className={cn(
            'fixed left-1/2 top-1/2 z-50 w-[calc(100vw-1.5rem)] max-w-md -translate-x-1/2 -translate-y-1/2',
            // never taller than the (mobile dynamic) viewport; scroll the body instead of clipping
            'max-h-[calc(100dvh-1.5rem)] overflow-y-auto overscroll-contain',
            'card p-4 shadow-2xl focus:outline-none sm:p-5',
            'data-[state=open]:animate-in data-[state=open]:fade-in data-[state=open]:zoom-in-95',
            className,
          )}
        >
          {title && (
            <div className="mb-4 flex items-center justify-between">
              <DialogPrimitive.Title className="text-lg">{title}</DialogPrimitive.Title>
              <DialogPrimitive.Close aria-label="Close" className="text-faint hover:text-foreground transition-colors">
                <X className="h-5 w-5" />
              </DialogPrimitive.Close>
            </div>
          )}
          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
