// @cellswap/chain-client: all CKB RPC calls go through here
import { ccc } from '@ckb-ccc/core'
import type { Cell, ChainConfig, HexString, OutPoint, Script, TxHash } from '@cellswap/types'

export class ChainClient {
  private client: ccc.Client

  // `opts.cccScripts` overrides the client's KnownScripts (needed on a local devnet,
  // whose system-script cell-deps differ from testnet's defaults). The caller (e.g. the
  // aggregator) loads offckb's CCC export and passes it; the browser SDK omits it.
  constructor(private config: ChainConfig, opts?: { cccScripts?: Record<string, unknown> }) {
    const scripts = opts?.cccScripts
    this.client = config.network === 'mainnet'
      ? new ccc.ClientPublicMainnet({ url: config.rpcUrl })
      : new ccc.ClientPublicTestnet({ url: config.rpcUrl, ...(scripts ? { scripts: scripts as any } : {}) })
  }

  async getLiveCellsByType(typeScript: Script): Promise<Cell[]> {
    const cells: Cell[] = []
    for await (const cell of this.client.findCells({
      script: {
        codeHash: typeScript.codeHash as `0x${string}`,
        hashType:  typeScript.hashType,
        args:      typeScript.args as `0x${string}`,
      },
      scriptType:       'type',
      scriptSearchMode: 'prefix',
    })) {
      cells.push(this.mapCell(cell))
    }
    return cells
  }

  /** Find live cells by an exact lock script (used to hydrate pool reserve cells). */
  async getLiveCellsByLock(lockScript: Script): Promise<Cell[]> {
    const cells: Cell[] = []
    for await (const cell of this.client.findCells({
      script: {
        codeHash: lockScript.codeHash as `0x${string}`,
        hashType:  lockScript.hashType,
        args:      lockScript.args as `0x${string}`,
      },
      scriptType:       'lock',
      scriptSearchMode: 'exact',
    })) {
      cells.push(this.mapCell(cell))
    }
    return cells
  }

  async getLiveCell(outPoint: OutPoint): Promise<Cell | null> {
    const result = await this.client.getCellLive(
      { txHash: outPoint.txHash as `0x${string}`, index: BigInt(outPoint.index) },
      true
    )
    return result ? this.mapCell(result) : null
  }

  async sendTransaction(tx: ccc.Transaction): Promise<TxHash> {
    return this.client.sendTransaction(tx) as Promise<TxHash>
  }

  async getTipEpoch(): Promise<bigint> {
    const header = await this.client.getTipHeader()
    // Epoch is [epochNumber, epochIndex, epochLength] tuple
    // header.epoch[0] = epoch number as Num (bigint)
    return BigInt(header.epoch[0])
  }

  get raw(): ccc.Client { return this.client }

  private mapCell(cell: ccc.Cell): Cell {
    return {
      outPoint: {
        txHash: cell.outPoint.txHash as TxHash,
        index:  Number(cell.outPoint.index),
      },
      output: {
        capacity: BigInt(cell.cellOutput.capacity),
        lock:     this.mapScript(cell.cellOutput.lock),
        type:     cell.cellOutput.type ? this.mapScript(cell.cellOutput.type) : undefined,
      },
      data: cell.outputData as HexString,
    }
  }

  private mapScript(s: ccc.Script): Script {
    return {
      codeHash: s.codeHash as HexString,
      hashType: s.hashType as Script['hashType'],
      args:     s.args as HexString,
    }
  }
}

export { Cell, ChainConfig } from '@cellswap/types'
