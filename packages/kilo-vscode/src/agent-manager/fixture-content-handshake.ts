import { isE2EFixtureEnabled } from "../util/e2e-fixture"

interface Waiter {
  gen: number
  resolve: (v: boolean) => void
  reject: (e: Error) => void
  timer: ReturnType<typeof setTimeout>
}

interface BarrierWaiter extends Waiter {
  token: string
}

/**
 * Fixture-only content-readiness handshake + per-seed barrier (KILO_E2E_FIXTURE).
 *
 * Vscode-free owner of the content generation and its waiter lists. Scoped to
 * a content generation distinct from the provider `generation` because the
 * fixture reload path preserves the same PanelContext/provider while the
 * webview document is replaced. Bumped on attach, fixture reload start, and
 * panel dispose; the ack resolves only waiters of the current generation
 * that have already seen the current generation's webviewReady.
 *
 * Barrier waiters are scoped to the content generation captured at wait time
 * plus the exact barrier token. An ack resolves only waiters whose gen is
 * still current and whose token matches exactly; stale generations and
 * mismatched tokens are ignored. Same lifecycle as content waiters:
 * attach/reload/dispose/shutdown reject and clear. Identical gen+token
 * waiters coalesce (one ack resolves all); distinct tokens resolve
 * independently so per-batch tokens never collide.
 *
 * The provider retains panel lifecycle, persistence, and business ownership:
 * it passes panel presence (`hasPanel`) and a post closure in, and calls
 * bump/fail/reset at the same attach/reload/dispose/shutdown points.
 */
export class FixtureContentHandshake {
  private gen = 0
  private readyGen: number | null = null
  private webviewReadyGen: number | null = null
  private contentWaiters: Waiter[] = []
  private barrierWaiters: BarrierWaiter[] = []

  /**
   * Fixture-only content-readiness intercept (KILO_E2E_FIXTURE).
   * Returns null when the message is consumed, undefined when the caller
   * should continue normal production handling. Production `webviewReady`
   * passes through unchanged; the fixture-only `agentManager.contentReady`
   * ack is consumed in all cases and only affects fixture state when the
   * fixture flag is enabled, the panel is present, and the current
   * generation has already seen its webviewReady. The fixture-only
   * `agentManager.fixtureBarrierAck` echo is likewise consumed in all cases
   * and resolves only exact current-generation/token barrier waiters.
   */
  intercept(msg: Record<string, unknown>, hasPanel: boolean): Record<string, unknown> | null | undefined {
    if (msg.type === "webviewReady") {
      this.markWebviewReady(hasPanel)
      return undefined
    }
    if (msg.type === "agentManager.fixtureBarrierAck") return this.ackBarrier(msg, hasPanel)
    if (msg.type !== "agentManager.contentReady") return undefined
    return this.ackContent(hasPanel)
  }

  private markWebviewReady(hasPanel: boolean): void {
    if (isE2EFixtureEnabled() && hasPanel) {
      this.webviewReadyGen = this.gen ?? 0
      this.readyGen = null
    }
  }

  private ackBarrier(msg: Record<string, unknown>, hasPanel: boolean): Record<string, unknown> | null {
    if (!isE2EFixtureEnabled()) return null
    if (!hasPanel) return null
    const token = msg.token
    if (typeof token !== "string" || token.length === 0) return null
    const gen = this.gen ?? 0
    const waiters = this.barrierWaiters ?? []
    const ready = waiters.filter((w) => w.gen === gen && w.token === token)
    if (ready.length === 0) return null
    this.barrierWaiters = waiters.filter((w) => !(w.gen === gen && w.token === token))
    for (const w of ready) {
      clearTimeout(w.timer)
      w.resolve(true)
    }
    return null
  }

  private ackContent(hasPanel: boolean): Record<string, unknown> | null {
    if (!isE2EFixtureEnabled()) return null
    if (!hasPanel) return null
    const gen = this.gen ?? 0
    if (this.webviewReadyGen !== gen) return null
    this.readyGen = gen
    const waiters = this.contentWaiters ?? []
    const ready = waiters.filter((w) => w.gen === gen)
    this.contentWaiters = waiters.filter((w) => w.gen !== gen)
    for (const w of ready) {
      clearTimeout(w.timer)
      w.resolve(true)
    }
    return null
  }

  bump(reason: Error): void {
    // Field initializers do not run on prototype-only test doubles
    // (Object.create), so default defensively here.
    this.gen = (this.gen ?? 0) + 1
    this.readyGen = null
    this.webviewReadyGen = null
    this.failContent(reason)
    this.failBarrier(reason)
  }

  failContent(reason: Error): void {
    const waiters = this.contentWaiters
    this.contentWaiters = []
    for (const w of waiters ?? []) {
      clearTimeout(w.timer)
      w.reject(reason)
    }
  }

  failBarrier(reason: Error): void {
    const waiters = this.barrierWaiters
    this.barrierWaiters = []
    for (const w of waiters ?? []) {
      clearTimeout(w.timer)
      w.reject(reason)
    }
  }

  /** Panel-dispose cleanup: reject pending waiters and reset readiness without bumping. */
  onPanelDisposed(reason: Error): void {
    this.failContent(reason)
    this.failBarrier(reason)
    this.readyGen = null
    this.webviewReadyGen = null
  }

  /** Fixture-only: current content generation (test inspection). */
  getGeneration(): number {
    return this.gen ?? 0
  }

  /** Fixture-only: pending content-ready waiter count (test inspection). */
  getContentCount(): number {
    return this.contentWaiters?.length ?? 0
  }

  /** Fixture-only: pending barrier waiter count (test inspection). */
  getBarrierCount(): number {
    return this.barrierWaiters?.length ?? 0
  }

  /**
   * Fixture-only: wait for the current panel/webview generation's
   * content-ready ack. Resolves true when the ack for the calling
   * generation arrives after its webviewReady. Rejects on timeout,
   * disposal, reload, or generation change. Coalesces concurrent waiters
   * for the same generation. Never resolves from webviewReady alone or
   * from a stale generation's ack.
   */
  waitForContent(hasPanel: boolean, timeoutMs = 15_000): Promise<boolean> {
    if (!isE2EFixtureEnabled()) throw new Error("fixture content-ready requires KILO_E2E_FIXTURE")
    if (!hasPanel) throw new Error("fixture content-ready: no Agent Manager panel")
    const gen = this.gen ?? 0
    if (this.readyGen === gen) return Promise.resolve(true)
    if (!this.contentWaiters) this.contentWaiters = []
    return new Promise<boolean>((resolve, reject) => {
      const timer = setTimeout(() => {
        const list = this.contentWaiters ?? []
        const idx = list.indexOf(entry)
        if (idx >= 0) list.splice(idx, 1)
        reject(new Error(`fixture content-ready: timeout waiting for generation ${gen}`))
      }, timeoutMs)
      const entry = {
        gen,
        resolve: (v: boolean) => resolve(v),
        reject: (e: Error) => reject(e),
        timer,
      }
      ;(this.contentWaiters ??= []).push(entry)
    })
  }

  /**
   * Fixture-only: per-seed delivery barrier (KILO_E2E_FIXTURE). Arranges the
   * waiter for the current content generation + token BEFORE posting the
   * barrier to the current panel (no fast-ack race), then awaits the
   * webview's `agentManager.fixtureBarrierAck` echo. Resolves true only on
   * the exact current generation/token ack. Rejects on empty token, no
   * panel, post failure, timeout, or generation change (attach/reload/
   * dispose/shutdown). Concurrent identical gen+token waiters coalesce (one
   * ack resolves all); distinct tokens resolve independently. Production
   * never calls this; no queue, no production postMessage change.
   */
  waitForBarrier(hasPanel: boolean, post: (msg: unknown) => void, token: string, timeoutMs = 15_000): Promise<boolean> {
    if (!isE2EFixtureEnabled()) throw new Error("fixture barrier requires KILO_E2E_FIXTURE")
    if (typeof token !== "string" || token.length === 0) throw new Error("fixture barrier: non-empty token required")
    if (!hasPanel) throw new Error("fixture barrier: no Agent Manager panel")
    const gen = this.gen ?? 0
    if (!this.barrierWaiters) this.barrierWaiters = []
    let entry: BarrierWaiter
    const gate = new Promise<boolean>((resolve, reject) => {
      const timer = setTimeout(() => {
        const list = this.barrierWaiters ?? []
        const idx = list.indexOf(entry)
        if (idx >= 0) list.splice(idx, 1)
        reject(new Error(`fixture barrier: timeout waiting for token ${token} generation ${gen}`))
      }, timeoutMs)
      entry = {
        gen,
        token,
        resolve: (v: boolean) => resolve(v),
        reject: (e: Error) => reject(e),
        timer,
      }
      ;(this.barrierWaiters ??= []).push(entry)
    })
    try {
      post({ type: "agentManager.fixtureBarrier", token })
    } catch (err) {
      const list = this.barrierWaiters ?? []
      const idx = list.indexOf(entry!)
      if (idx >= 0) list.splice(idx, 1)
      clearTimeout(entry!.timer)
      throw new Error(`fixture barrier: post failed for token ${token}: ${String(err)}`)
    }
    return gate.then((ok) => {
      if ((this.gen ?? 0) !== gen) throw new Error(`fixture barrier: generation changed for token ${token}`)
      return ok
    })
  }
}
