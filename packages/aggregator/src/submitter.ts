// submitter.ts: serves the /health endpoint and tracks settlement telemetry

import { createServer } from 'http'
import { ChainClient } from '@cellswap/chain-client'

interface HealthStatus {
  status:           'ok' | 'degraded' | 'down'
  lastSettlement:   number    // unix ms
  pendingIntents:   number
  poolCellAge:      number    // blocks since last pool update
  uptime:           number    // ms
  settledTotal:     number
  errors24h:        number
}

export class Submitter {
  private startTime     = Date.now()
  private lastSettlement = 0
  private settledTotal  = 0
  private errors24h     = 0
  private pendingIntents = 0
  private poolCellAge   = 0
  private healthServer: ReturnType<typeof createServer> | null = null

  constructor(private chain: ChainClient) {}

  /** Record a successful settlement so /health reflects real activity (called by the aggregator
   *  loop after a batch or resting order settles). */
  recordSettlement(count = 1): void {
    this.lastSettlement = Date.now()
    this.settledTotal += count
  }

  /** Record a settlement failure (feeds the /health error counter). */
  recordError(): void {
    this.errors24h++
  }

  // Update health metrics (called by aggregator loop)
  updateMetrics(pending: number, poolAge: number): void {
    this.pendingIntents = pending
    this.poolCellAge    = poolAge
  }

  // Health check HTTP server, used by monitoring and the Docker healthcheck
  startHealthServer(port = 3001): void {
    this.healthServer = createServer((req, res) => {
      if (req.url !== '/health') {
        res.writeHead(404)
        res.end()
        return
      }

      const status = this.getHealth()
      const code   = status.status === 'ok' ? 200 : status.status === 'degraded' ? 200 : 503

      res.writeHead(code, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(status))
    })

    this.healthServer.listen(port, () => {
      console.log(`[health] server on :${port}`)
    })
  }

  stopHealthServer(): void {
    this.healthServer?.close()
  }

  private getHealth(): HealthStatus {
    const now         = Date.now()
    const timeSinceLast = now - this.lastSettlement
    const uptime      = now - this.startTime

    // Degraded if no settlement in 5 minutes and pending intents exist
    const status = this.pendingIntents > 0 && timeSinceLast > 5 * 60 * 1000
      ? 'degraded'
      : this.poolCellAge > 100 // pool cell not updated in 100 blocks
      ? 'degraded'
      : 'ok'

    return {
      status,
      lastSettlement: this.lastSettlement,
      pendingIntents: this.pendingIntents,
      poolCellAge:    this.poolCellAge,
      uptime,
      settledTotal:   this.settledTotal,
      errors24h:      this.errors24h,
    }
  }
}
