import { useState } from 'react'
import { ccc } from '@ckb-ccc/connector-react'
import { Dialog } from './ui/dialog'
import { Button } from './ui/button'

/** The wallet picker is a generic third-party modal we cannot label, so newcomers freeze ("which one
 *  is JoyID?"). This shared pre-step names the first-timer pick before the picker opens, so every
 *  Connect entry point (header, swap card, ...) gives the same guidance instead of only the header.
 *  Usage: const { promptConnect, connectPromptNode } = useConnectPrompt(); call promptConnect() where
 *  you would have called open(), and render {connectPromptNode} once. */
export function useConnectPrompt() {
  const { open } = ccc.useCcc()
  const [promptOpen, setPromptOpen] = useState(false)
  const connectPromptNode = (
    <Dialog open={promptOpen} onOpenChange={setPromptOpen} title="Choose how to connect">
      <p className="text-sm leading-snug text-muted">A wallet window will open next.</p>
      <div className="mt-3 rounded-xl border border-border bg-surface-2/50 p-3 text-sm">
        <div className="font-medium text-foreground">New here? Pick JoyID.</div>
        <p className="mt-1 text-xs leading-snug text-faint">
          It is a free wallet that uses Face ID or your fingerprint, with no seed phrase and no app to
          install. It is also what the custody-free Batch mode needs.
        </p>
        <p className="mt-2 text-xs leading-snug text-faint">
          Already have a CKB wallet? Pick it from the list instead.
        </p>
      </div>
      <Button className="mt-4 w-full" onClick={() => { setPromptOpen(false); open() }}>
        Continue to wallet
      </Button>
    </Dialog>
  )
  return { promptConnect: () => setPromptOpen(true), connectPromptNode }
}
