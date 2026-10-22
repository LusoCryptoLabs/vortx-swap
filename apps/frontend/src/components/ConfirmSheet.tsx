import { type ReactNode } from 'react'
import { Dialog } from './ui/dialog'
import { Button } from './ui/button'

export interface ConfirmRow { label: string; value: ReactNode; emphasize?: boolean }

/** A lightweight review/confirm step shown before a wallet signature. It summarizes a money-moving
 *  action (swap, send, limit order) in plain language so a first-timer never signs something they
 *  did not read. Built on the shared Dialog. The caller owns `open` and gathers the summary rows;
 *  `onConfirm` fires the real action (which still prompts the wallet). */
export function ConfirmSheet({
  open, onOpenChange, title, rows, note, confirmLabel = 'Confirm', cancelLabel = 'Cancel', onConfirm, busy,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  title: ReactNode
  rows: ConfirmRow[]
  note?: ReactNode
  confirmLabel?: string
  cancelLabel?: string
  onConfirm: () => void
  busy?: boolean
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={title}>
      <div className="space-y-2 rounded-xl border border-border bg-surface-2/50 p-3 text-sm">
        {rows.map((r, i) => (
          <div key={i} className="flex items-start justify-between gap-3">
            <span className="text-faint">{r.label}</span>
            <span className={r.emphasize ? 'num text-right font-medium' : 'num text-right text-foreground'}>{r.value}</span>
          </div>
        ))}
      </div>
      {note != null && (
        <p className="mt-3 rounded-lg bg-surface-2/60 px-3 py-2 text-xs leading-snug text-muted">{note}</p>
      )}
      <div className="mt-4 flex gap-2">
        <Button variant="secondary" className="flex-1" onClick={() => onOpenChange(false)} disabled={busy}>{cancelLabel}</Button>
        <Button className="flex-1" onClick={onConfirm} disabled={busy}>{busy ? 'Confirm in wallet…' : confirmLabel}</Button>
      </div>
    </Dialog>
  )
}
