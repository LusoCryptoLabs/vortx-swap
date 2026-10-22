import * as PopoverPrimitive from '@radix-ui/react-popover'
import { Info } from 'lucide-react'
import { useState } from 'react'
import { cn } from '../../lib/utils'

/** A small "what is this?" info icon with a tappable + hover popover. Use it next to a label or
 *  number that a non-technical person wouldn't understand on its own.
 *
 *  Works on touch (tap to open, tap again / tap outside / Escape to dismiss) and desktop (hover or
 *  keyboard-focus to open). Built on Radix Popover so it's keyboard-focusable and screen-reader
  *  accessible (the trigger is a real labelled button, the panel is its popover). Pass `text` (and
  *  optionally `className`). */
export function Hint({ text, className }: { text: string; className?: string }) {
  const [open, setOpen] = useState(false)
  // A click/tap "pins" the popover open so a later mouse-leave (or focus loss to the panel) doesn't
  // immediately dismiss it. Hover-only opens stay unpinned and close when the pointer leaves.
  const [pinned, setPinned] = useState(false)

  const close = () => { setPinned(false); setOpen(false) }
  const pin = () => { setPinned(true); setOpen(true) }

  return (
    <PopoverPrimitive.Root
      open={open}
      onOpenChange={(o) => { setOpen(o); if (!o) setPinned(false) }}
    >
      <PopoverPrimitive.Trigger asChild>
        <button
          type="button"
          aria-label="More info"
          className={cn('group/hint inline-flex align-middle focus:outline-none', className)}
          // Tap/click pins it open, or dismisses it if already pinned (toggle on touch). Stop the
          // event from also activating a clickable ancestor row/card the hint may live inside.
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); if (pinned) close(); else pin() }}
          // Desktop hover: open on enter, close on leave unless a tap has pinned it.
          onMouseEnter={() => setOpen(true)}
          onMouseLeave={() => { if (!pinned) setOpen(false) }}
          // Keyboard: open on focus, close on blur unless pinned by a tap.
          onFocus={() => setOpen(true)}
          onBlur={() => { if (!pinned) setOpen(false) }}
        >
          <Info
            className="h-3.5 w-3.5 cursor-help text-faint transition-colors hover:text-foreground group-focus/hint:text-foreground"
            aria-hidden
          />
        </button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          side="top"
          align="center"
          sideOffset={6}
          collisionPadding={16}
          // Don't steal focus when opening; let the trigger keep it for keyboard users.
          onOpenAutoFocus={(e) => e.preventDefault()}
          className="z-50 w-56 max-w-[calc(100vw-2rem)] rounded-lg border border-border bg-surface px-2.5 py-2 text-left text-xs font-normal leading-snug text-muted shadow-xl focus:outline-none"
        >
          {text}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  )
}
