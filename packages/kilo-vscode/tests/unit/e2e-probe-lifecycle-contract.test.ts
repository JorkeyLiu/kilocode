import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const lifecycleSrc = readFileSync(join(import.meta.dirname, "../../script/e2e-probe-lifecycle.ts"), "utf8")
const domSrc = readFileSync(join(import.meta.dirname, "../../script/e2e-probe-dom.ts"), "utf8")

describe("lifecycle no synthetic tab selection", () => {
  it("contains zero DOM synthetic tab clicks via evaluate el.click", () => {
    // No synthetic tab selection: evaluate that clicks .am-tab-sortable
    expect(lifecycleSrc).not.toContain("el.click()")
    // Ensure no evaluate with data-tab-id and click
    const evalTabClick = lifecycleSrc.match(/\.evaluate\([^)]*data-tab-id/g) ?? []
    expect(evalTabClick.length).toBe(0)
  })

  it("uses real Playwright tab selection via selectLifecycleTab or clickTab locator", () => {
    // Must use shared clickTab or selectLifecycleTab helper with locator targeting .am-tab-sortable[data-tab-id]
    expect(lifecycleSrc).toContain("selectLifecycleTab")
    // clickTab itself is defined in dom with locator targeting .am-tab-sortable
    expect(domSrc).toContain('.am-tab-sortable[data-tab-id')
    expect(domSrc).toContain("locator(`.am-tab-sortable[data-tab-id")
    // lifecycle bounce uses selectLifecycleTab for both sibling and target
    expect(lifecycleSrc).toContain("selectLifecycleTab(browser, amFrame2, phase0.siblingId")
    expect(lifecycleSrc).toContain("selectLifecycleTab(browser, amFrame2, phase0.sessionId")
    expect(lifecycleSrc).toContain("selectLifecycleTab(browser, panelFrame, phase0.siblingId")
    expect(lifecycleSrc).toContain("selectLifecycleTab(browser, panelFrame, phase0.sessionId")
  })

  it("has zero direct tab-selection .click outside shared helper", () => {
    // All lifecycle .am-tab-sortable[data-tab-id] session selection must go through selectLifecycleTab
    // Direct locator(...).click outside helper is forbidden; read-only locators/assertions may remain but not click
    const directLocatorClicks = lifecycleSrc.match(/\.am-tab-sortable\[data-tab-id[^\n]*\.click\(/g) ?? []
    expect(directLocatorClicks.length).toBe(0)
    const locatorClicks = lifecycleSrc.match(/locator\(`\.am-tab-sortable\[data-tab-id/g) ?? []
    expect(locatorClicks.length).toBe(0)
  })

  it("all lifecycle session selection through selectLifecycleTab with exact 11 calls, timeout 10000, ids limited sibling/target", () => {
    const allCalls = (lifecycleSrc.match(/selectLifecycleTab\(/g) ?? []).length
    expect(allCalls).toBe(11)
    const withTimeout = (lifecycleSrc.match(/selectLifecycleTab\(browser,\s*[^,]+,\s*[^,]+,\s*10000\)/g) ?? []).length
    expect(withTimeout).toBe(11)
    expect(withTimeout).toBe(allCalls)
    // ids limited to sibling/target family: either phase0.siblingId/sessionId or plain sessionId derived from phase0
    const callIdMatches = [...lifecycleSrc.matchAll(/selectLifecycleTab\(browser,\s*[^,]+,\s*([^,]+),\s*10000\)/g)].map((m) => m[1]!.trim())
    expect(callIdMatches.length).toBe(11)
    for (const id of callIdMatches) {
      const ok = id === "phase0.siblingId" || id === "phase0.sessionId" || id === "sessionId"
      expect(ok).toBeTrue()
    }
    // zero direct clickTab or tab locator click in lifecycle
    const clickTabCalls = (lifecycleSrc.match(/\bclickTab\(/g) ?? []).length
    expect(clickTabCalls).toBe(0)
    const clickVisibleCalls = (lifecycleSrc.match(/\bclickVisibleTab\(/g) ?? []).length
    expect(clickVisibleCalls).toBe(0)
    const waitForTabCalls = (lifecycleSrc.match(/\bwaitForTab\(/g) ?? []).length
    expect(waitForTabCalls).toBe(0)
    expect(lifecycleSrc).not.toMatch(/\.locator\(`\.am-tab-sortable\[data-tab-id.*\.click/)
  })

  it("has no swallowed catch or unreachable fallback around tab selection", () => {
    // No swallowed catch that would hide wait failure and skip fallback
    // Old pattern: .catch(() => {}) or .catch(() => false) or if (!clicked) fallback
    const bounceSlice = lifecycleSrc.slice(
      lifecycleSrc.indexOf("Force a real tab switch"),
      lifecycleSrc.indexOf("Force a real tab switch") + 3000,
    )
    expect(bounceSlice).not.toContain(".catch(() => {})")
    expect(bounceSlice).not.toContain(".catch(() => false)")
    expect(bounceSlice).not.toContain("if (!clicked)")
    // Ensure no clickTab(...).catch in lifecycle
    expect(lifecycleSrc).not.toContain("clickTab(" + "amFrame2, phase0.sessionId, 5000).catch")
    expect(lifecycleSrc).not.toMatch(/clickTab\([^)]+\)\.catch/)
  })

  it("reacquires detached AM frame via redacted finder, not first non-AM", () => {
    expect(lifecycleSrc).toContain("findAgentManagerFrameAnyRedacted")
    // bounce blocks handle detached via selectLifecycleTab which uses redacted finder internally
    // panelFrame block explicitly checks isDetached then reacquires
    expect(lifecycleSrc).toContain("isDetached()")
    // ensure no first-non-AM selection (should not contain generic frame selection without AM-layout)
    // The helper selectLifecycleTab and panelFrame reacquire both use findAgentManagerFrameAnyRedacted
    const domHelper = domSrc.slice(domSrc.indexOf("export async function selectLifecycleTab"), domSrc.indexOf("export async function selectLifecycleTab") + 4000)
    expect(domHelper).toContain("findAgentManagerFrameAnyRedacted")
    expect(domHelper).toContain("isDetached()")
  })

  it("bounce control simplified without duplicate fallback branches", () => {
    const start = lifecycleSrc.indexOf("let amFrame2 = (await findAgentManagerFrameAnyRedacted")
    const end = lifecycleSrc.indexOf("await waitForHeaderTitle(amFrame2, gcTitle, 10000)", start) + 80
    const bounce = lifecycleSrc.slice(start, end)
    // Simplified: if beforeActive==target bounce sibling then target; else if sibling or unexpected click target
    expect(bounce).toContain('if (beforeActive === phase0.sessionId)')
    expect(bounce).toContain('} else if (beforeActive === phase0.siblingId)')
    expect(bounce).toContain('} else {')
    // Should have exactly 4 selectLifecycleTab static calls in bounce (2 for bounce path +1 sibling +1 unexpected)
    const count = (bounce.match(/selectLifecycleTab/g) ?? []).length
    expect(count).toBe(4)
  })

  it("preserves pre-panel-close semantics with real clicks", () => {
    const panelSlice = lifecycleSrc.slice(
      lifecycleSrc.indexOf("let panelFrame: Frame = initialFrame"),
      lifecycleSrc.indexOf("let panelFrame: Frame = initialFrame") + 1500,
    )
    expect(panelSlice).toContain("isDetached()")
    expect(panelSlice).toContain("selectLifecycleTab(browser, panelFrame, phase0.siblingId")
    expect(panelSlice).toContain("selectLifecycleTab(browser, panelFrame, phase0.sessionId")
  })

  it("dom helper logs only hash/count/category, no raw IDs", () => {
    const helper = domSrc.slice(domSrc.indexOf("export async function selectLifecycleTab"), domSrc.indexOf("export async function selectLifecycleTab") + 4000)
    // No raw id logging like sessionId or gcTitle in helper
    expect(helper).not.toContain("sessionIdHash")
    expect(helper).not.toContain("gcTitle")
    // helper should not contain console.log with raw
    expect(helper).not.toMatch(/console\.log.*phase0/)
  })
})

describe("selectLifecycleTab strict total deadline contract", () => {
  const helper = domSrc.slice(domSrc.indexOf("export async function selectLifecycleTab"), domSrc.indexOf("export async function selectLifecycleTab") + 6000)
  const clickHelper = domSrc.slice(domSrc.indexOf("export async function clickTab"), domSrc.indexOf("export async function clickTab") + 1200)

  it("sets deadline at entry and computes remaining before each operation", () => {
    // deadline set at entry
    expect(helper).toContain("const deadline = Date.now() + timeoutMs")
    // remainingOrThrow must sample once per call: single `remaining = deadline - Date.now()` then immediate check and return
    expect(helper).toContain("const remaining = deadline - Date.now()")
    expect(helper).toContain("if (remaining <= 0)")
    expect(helper).toContain('emit("deadline"')
    expect(helper).toContain("tabDeadlineError")
    expect(helper).toContain("targetHash")
    expect(helper).not.toContain("`probe: activeTabId ${active")
    expect(helper).toContain("return remaining")
    // no stale sampling: must not capture r1/r2/r3/r4 and return old r1
    expect(helper).not.toContain("const r1 = deadline - Date.now()")
    expect(helper).not.toContain("const remaining = r1")
    expect(helper).not.toContain("void r2")
    // every operation guarded via remainingOrThrow result bounded by remaining
    expect(helper).toContain("findAgentManagerFrameAnyRedacted(browser, remaining")
    expect(helper).toContain("await waitForTabTarget(cur, tabId, remaining")
    expect(helper).toContain("await clickVisibleTabTarget(cur, tabId, remaining")
  })

  it("clickTab splits single timeout into wait and click without double budget", () => {
    expect(clickHelper).toContain("const deadline = Date.now() + timeoutMs")
    expect(clickHelper).toContain("remainingWait")
    expect(clickHelper).toContain("remainingClick")
    // clickTab delegates to split helpers with bounded timeouts — inner target only
    expect(clickHelper).toContain("await waitForTabTarget(frame, tabId, remainingWait")
    expect(clickHelper).toContain("await clickVisibleTabTarget(frame, tabId, remainingClick")
    expect(clickHelper).toContain("tabStageError")
    expect(clickHelper).toContain("targetHash")
    expect(clickHelper).not.toContain("`probe: activeTabId")
    expect(clickHelper).not.toContain("timeout: timeoutMs")
    expect(clickHelper).not.toContain("void remLocator")
  })

  it("every operation fails fixed category when remaining <=0 and sleeps bounded", () => {
    expect(helper).toContain("remaining <= 0")
    expect(helper).toContain("tabDeadlineError")
    expect(helper).toContain("tabStageError")
    expect(helper).toContain("Math.min(250, remaining)")
    // no unbounded sleep(250) without remaining cap in active poll
    const boundedSleeps = (helper.match(/Math\.min\(250, remaining/g) ?? []).length
    expect(boundedSleeps).toBeGreaterThanOrEqual(1)
  })

  it("handles frame detach during/after click within same budget via positive reacquire and bounded single retry with stage split", () => {
    // positive redacted finder
    expect(helper).toContain("findAgentManagerFrameAnyRedacted")
    // retry on detached during click
    expect(helper).toContain("isDetached()")
    // bounded retry: only one retry path (rem2/rem3)
    expect(helper).toContain("rem2")
    expect(helper).toContain("rem3")
    // stage split: wait outside catch, only click inside try — inner target
    expect(helper).toContain("await waitForTabTarget(cur, tabId, remainingWait")
    expect(helper).toContain("await clickVisibleTabTarget(cur, tabId, remainingClick")
    expect(helper).toContain("try {")
    // exactly one retry does wait+click on fresh frame (inner target)
    const waitCalls = (helper.match(/await waitForTabTarget\(/g) ?? []).length
    expect(waitCalls).toBe(2)
    const clickCalls = (helper.match(/await clickVisibleTabTarget\(/g) ?? []).length
    expect(clickCalls).toBe(2)
  })

  it("final active semantics unchanged and all branches check active", () => {
    expect(helper).toContain('if (active === tabId) return cur')
    expect(helper).not.toContain('`probe: activeTabId ${active ?? "<none>"} != ${tabId}`')
    expect(helper).toContain("tabDeadlineError")
    // deadline emit covers detached case via active ?? "<none>" path, no separate literal needed
    expect(helper).toContain('emit("deadline"')
  })
})

describe("selectLifecycleTab behavior contract", () => {
  it("clicks via locator and waits for activeTabId", async () => {
    const { selectLifecycleTab } = await import("../../script/e2e-probe-dom")
    let clickedId: string | null = null
    let active: string | undefined = "sibling-id"
    const frame: any = {
      isDetached: () => false,
      locator: (sel: string) => {
        if (sel === ".am-layout") return { count: async () => 1 } as any
        return {
          first: () => ({
            waitFor: async () => {},
            click: async () => {
              const m = sel.match(/data-tab-id="([^"]+)"/)
              if (m) {
                clickedId = m[1]!
                active = clickedId
              }
            },
          }),
        } as any
      },
      evaluate: async () => {
        return active
      },
    }
    const browser: any = { contexts: () => [] }
    const res = await selectLifecycleTab(browser, frame as any, "target-id", 1000)
    expect(clickedId).toBe("target-id")
    expect(res).toBe(frame)
  })

  it("reacquires detached frame via redacted finder before click", async () => {
    const { selectLifecycleTab } = await import("../../script/e2e-probe-dom")
    let replClicked = false
    const detachedFrame: any = {
      isDetached: () => true,
      locator: () => ({
        first: () => ({ waitFor: async () => {}, click: async () => {} }),
        count: async () => 0,
      }),
      evaluate: async () => undefined,
    }
    const browser2: any = {
      contexts: () => [
        {
          pages: () => [
            {
              frames: () => [
                {
                  url: () => "https://vscode-webview.example.com/vs",
                  locator: (sel: string) => {
                    if (sel === ".am-layout") return { count: async () => 1 } as any
                    return {
                      first: () => ({
                        waitFor: async () => {},
                        click: async () => {
                          replClicked = true
                        },
                      }),
                    } as any
                  },
                  evaluate: async () => "target-id",
                  isDetached: () => false,
                },
              ],
              url: () => "https://vscode-webview.example.com",
            },
          ],
        },
      ],
    }
    const res = await selectLifecycleTab(browser2, detachedFrame as any, "target-id", 2000)
    expect(replClicked).toBeTrue()
    expect(res.isDetached()).toBeFalse()
  })

  it("wait failure throws without skipping to fallback", async () => {
    const { selectLifecycleTab } = await import("../../script/e2e-probe-dom")
    let clickCount = 0
    let finderCalls = 0
    const logs: string[] = []
    const origLog = console.log
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "))
    }
    try {
      const frame: any = {
        isDetached: () => false,
        locator: (sel: string) => {
          if (sel === ".am-layout") return { count: async () => 1 } as any
          return {
            first: () => ({
              waitFor: async () => {
                throw new Error("playwright wait timeout selector=.am-tab-sortable[data-tab-id=\"target-id\"] .am-tab-target")
              },
              click: async () => {
                clickCount++
              },
            }),
          } as any
        },
        evaluate: async () => "still-sibling",
      }
      const browser: any = {
        contexts: () => {
          finderCalls++
          return []
        },
      }
      let err = ""
      try {
        await selectLifecycleTab(browser, frame as any, "target-id", 600)
      } catch (e) {
        err = String(e)
      }
      expect(err).toContain("tab-select wait failed")
      expect(err).toContain("targetHash=")
      expect(err).not.toContain("target-id")
      expect(err).not.toContain("sentinel")
      expect(clickCount).toBe(0)
      expect(finderCalls).toBe(0)
      const diagLine = logs.find((l) => l.includes("[probe] lifecycle-select"))
      expect(diagLine).toBeDefined()
      const payload = JSON.parse(diagLine!.slice(diagLine!.indexOf("{")) )
      expect(payload.stage).toBe("wait")
      expect(payload.waitAttempts).toBe(1)
      expect(payload.clickAttempts).toBe(0)
    } finally {
      console.log = origLog
    }
  })

  it("wait failure with detached frame sanitized and never retries", async () => {
    const { selectLifecycleTab } = await import("../../script/e2e-probe-dom")
    let clickCount = 0
    let finderCalls = 0
    let waitCalls = 0
    const logs: string[] = []
    const origLog = console.log
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "))
    }
    try {
      let detachedCalls = 0
      const frame: any = {
        isDetached: () => {
          detachedCalls++
          if (detachedCalls === 1) return false
          return true
        },
        locator: () => ({
          first: () => ({
            waitFor: async () => {
              waitCalls++
              throw new Error("playwright wait timeout selector=.am-tab-sortable[data-tab-id=\"target-id\"] .am-tab-target")
            },
            click: async () => {
              clickCount++
            },
          }),
          count: async () => 0,
        }),
        evaluate: async () => "still-sibling",
      }
      const freshFrame: any = {
        isDetached: () => false,
        locator: () => ({
          first: () => ({
            waitFor: async () => {},
            click: async () => {
              clickCount++
            },
          }),
          count: async () => 1,
        }),
        evaluate: async () => "target-id",
      }
      const browser: any = {
        contexts: () => {
          finderCalls++
          return [
            {
              pages: () => [
                {
                  frames: () => [
                    {
                      url: () => "https://vscode-webview.example.com/vs",
                      locator: freshFrame.locator,
                      evaluate: freshFrame.evaluate,
                      isDetached: freshFrame.isDetached,
                    },
                  ],
                  url: () => "https://vscode-webview.example.com",
                },
              ],
            },
          ]
        },
      }
      let caught: unknown
      try {
        await selectLifecycleTab(browser, frame as any, "target-id", 600)
      } catch (e) {
        caught = e
      }
      expect(String(caught)).toContain("tab-select wait failed")
      expect(String(caught)).toContain("targetHash=")
      expect(String(caught)).not.toContain("target-id")
      expect(waitCalls).toBe(1)
      expect(clickCount).toBe(0)
      expect(finderCalls).toBe(0)
      const diagLine = logs.find((l) => l.includes("[probe] lifecycle-select"))
      expect(diagLine).toBeDefined()
      const payload = JSON.parse(diagLine!.slice(diagLine!.indexOf("{")))
      expect(payload.stage).toBe("wait")
      expect(payload.waitAttempts).toBe(1)
    } finally {
      console.log = origLog
    }
  })

  it("total elapsed bounded incl slow locator/reacquire within single budget", async () => {
    const { selectLifecycleTab } = await import("../../script/e2e-probe-dom")
    let active: string | undefined = "target-id"
    const waits: number[] = []
    const clicks: number[] = []
    const timeout = 400
    const frame: any = {
      isDetached: () => false,
      locator: (sel: string) => {
        if (sel === ".am-layout") return { count: async () => 1 } as any
        return {
          first: () => ({
            waitFor: async (opts: any) => {
              waits.push(opts.timeout)
              expect(opts.timeout).toBeGreaterThan(0)
              expect(opts.timeout).toBeLessThanOrEqual(timeout)
              if (clicks.length > 0) expect(opts.timeout).toBeLessThanOrEqual(clicks[clicks.length - 1] + 5)
              await new Promise((r) => setTimeout(r, 80))
            },
            click: async (opts: any) => {
              clicks.push(opts.timeout)
              expect(opts.timeout).toBeGreaterThan(0)
              expect(opts.timeout).toBeLessThanOrEqual(timeout)
              if (waits.length > 0) expect(opts.timeout).toBeLessThanOrEqual(waits[waits.length - 1] + 5)
              await new Promise((r) => setTimeout(r, 80))
            },
          }),
        } as any
      },
      evaluate: async () => active,
    }
    const browser: any = { contexts: () => [] }
    const start = Date.now()
    const res = await selectLifecycleTab(browser, frame as any, "target-id", timeout)
    const elapsed = Date.now() - start
    expect(res).toBe(frame)
    expect(waits.length).toBe(1)
    expect(clicks.length).toBe(1)
    expect(waits[0]!).toBeGreaterThan(0)
    expect(clicks[0]!).toBeGreaterThan(0)
    expect(clicks[0]!).toBeLessThanOrEqual(waits[0]!)
    expect(elapsed).toBeLessThan(timeout + 80)
    expect(elapsed).toBeGreaterThanOrEqual(150)
  })

  it("click throws with detached frame does exactly one reacquire retry and two click attempts", async () => {
    const { selectLifecycleTab } = await import("../../script/e2e-probe-dom")
    let finderCalls = 0
    let waitCalls = 0
    let clickCalls = 0
    const frame: any = {
      isDetached: () => {
        // first check (initial reacquire): false, second check (catch) will be true
        // we need to flip after first click attempt
        return false
      },
      locator: () => ({
        first: () => ({
          waitFor: async () => {
            waitCalls++
          },
          click: async () => {
            clickCalls++
            if (clickCalls === 1) throw new Error("sentinel-click-detach")
          },
        }),
        count: async () => 1,
      }),
      evaluate: async () => "target-id",
    }
    // Make isDetached return true after first click failure
    let detachedAfterFirstClick = false
    const origIsDetached = frame.isDetached
    frame.isDetached = () => {
      if (clickCalls >= 1) return true
      return origIsDetached()
    }
    const freshFrame: any = {
      isDetached: () => false,
      locator: () => ({
        first: () => ({
          waitFor: async () => {
            waitCalls++
          },
          click: async () => {
            clickCalls++
          },
        }),
        count: async () => 1,
      }),
      evaluate: async () => "target-id",
    }
    const browser: any = {
      contexts: () => {
        finderCalls++
        return [
          {
            pages: () => [
              {
                frames: () => [
                  {
                    url: () => "https://vscode-webview.example.com/vs",
                    locator: freshFrame.locator,
                    evaluate: freshFrame.evaluate,
                    isDetached: freshFrame.isDetached,
                  },
                ],
                url: () => "https://vscode-webview.example.com",
              },
            ],
          },
        ]
      },
    }
    const res = await selectLifecycleTab(browser, frame as any, "target-id", 2000)
    expect(clickCalls).toBe(2)
    expect(waitCalls).toBe(2)
    expect(finderCalls).toBe(1)
    expect(res.isDetached()).toBeFalse()
  })

  it("frame detaches during click and helper reacquires/retries bounded", async () => {
    const { selectLifecycleTab } = await import("../../script/e2e-probe-dom")
    let isDetachedCalls = 0
    let detachedAfterFirstClick = false
    let clickCount = 0
    let waitCount = 0
    const origFrame: any = {
      isDetached: () => {
        isDetachedCalls++
        if (isDetachedCalls === 1) return false
        return detachedAfterFirstClick
      },
      locator: (sel: string) => {
        if (sel === ".am-layout") return { count: async () => 1 } as any
        return {
          first: () => ({
            waitFor: async () => {
              waitCount++
            },
            click: async () => {
              clickCount++
              if (clickCount === 1) {
                detachedAfterFirstClick = true
                throw new Error("frame detached during click")
              }
            },
          }),
        } as any
      },
      evaluate: async () => "target-id",
    }
    const freshFrame: any = {
      isDetached: () => false,
      locator: (sel: string) => {
        if (sel === ".am-layout") return { count: async () => 1 } as any
        return {
          first: () => ({
            waitFor: async () => {
              waitCount++
            },
            click: async () => {
              clickCount++
            },
          }),
        } as any
      },
      evaluate: async () => "target-id",
    }
    const browser: any = {
      contexts: () => [
        {
          pages: () => [
            {
              frames: () => [
                {
                  url: () => "https://vscode-webview.example.com/vs",
                  locator: freshFrame.locator,
                  evaluate: freshFrame.evaluate,
                  isDetached: freshFrame.isDetached,
                },
              ],
              url: () => "https://vscode-webview.example.com",
            },
          ],
        },
      ],
    }
    const res = await selectLifecycleTab(browser, origFrame as any, "target-id", 2000)
    expect(clickCount).toBe(2)
    expect(waitCount).toBe(2)
    expect(isDetachedCalls).toBeGreaterThanOrEqual(2)
    expect(res.isDetached()).toBeFalse()
  })

  it("timeout no fallback/unbounded retry and throws fixed category", async () => {
    const { selectLifecycleTab } = await import("../../script/e2e-probe-dom")
    const waits: number[] = []
    const clicks: number[] = []
    const timeout = 300
    const frame: any = {
      isDetached: () => false,
      locator: (sel: string) => {
        if (sel === ".am-layout") return { count: async () => 1 } as any
        return {
          first: () => ({
            waitFor: async (opts: any) => {
              waits.push(opts.timeout)
              expect(opts.timeout).toBeGreaterThan(0)
              expect(opts.timeout).toBeLessThanOrEqual(timeout)
            },
            click: async (opts: any) => {
              clicks.push(opts.timeout)
              expect(opts.timeout).toBeGreaterThan(0)
              expect(opts.timeout).toBeLessThanOrEqual(timeout)
              if (waits.length > 0) expect(opts.timeout).toBeLessThanOrEqual(waits[waits.length - 1] + 5)
            },
          }),
        } as any
      },
      evaluate: async () => "never-target",
    }
    const browser: any = { contexts: () => [] }
    const start = Date.now()
    let err = ""
    try {
      await selectLifecycleTab(browser, frame as any, "target-id", timeout)
    } catch (e) {
      err = String(e)
    }
    const elapsed = Date.now() - start
    expect(err).toContain("tab-select deadline")
    expect(err).toContain("targetHash=")
    expect(err).not.toContain("target-id")
    expect(err).not.toContain("fallback")
    expect(waits.length).toBe(1)
    expect(clicks.length).toBe(1)
    expect(clicks[0]!).toBeLessThanOrEqual(waits[0]!)
    expect(elapsed).toBeLessThan(timeout + 80)
    expect(elapsed).toBeGreaterThanOrEqual(timeout - 30)
  })

  it("all branch final active checks return attached frame", async () => {
    const { selectLifecycleTab } = await import("../../script/e2e-probe-dom")
    for (const target of ["a", "b"]) {
      let active: string | undefined = target
      const frame: any = {
        isDetached: () => false,
        locator: () => ({
          first: () => ({ waitFor: async () => {}, click: async () => {} }),
          count: async () => 1,
        }),
        evaluate: async () => active,
      }
      const browser: any = { contexts: () => [] }
      const res = await selectLifecycleTab(browser, frame as any, target, 1000)
      expect(res.isDetached()).toBeFalse()
      expect(await res.evaluate(() => "")).toBe(target)
    }
  })

  it("attached click failure never retries: one wait/one click, zero finder, sanitized stage", async () => {
    const { selectLifecycleTab } = await import("../../script/e2e-probe-dom")
    let waitCalls = 0
    let clickCalls = 0
    let finderCalls = 0
    const logs: string[] = []
    const origLog = console.log
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "))
    }
    try {
      const frame: any = {
        isDetached: () => false,
        locator: () => ({
          first: () => ({
            waitFor: async () => {
              waitCalls++
            },
            click: async () => {
              clickCalls++
              throw new Error("playwright click timeout selector=.am-tab-sortable[data-tab-id=\"target-id\"] .am-tab-target")
            },
          }),
          count: async () => 0,
        }),
        evaluate: async () => "still-sibling",
      }
      const browser: any = {
        contexts: () => {
          finderCalls++
          return []
        },
      }
      let caught: unknown
      try {
        await selectLifecycleTab(browser, frame as any, "target-id", 1000)
      } catch (e) {
        caught = e
      }
      expect(String(caught)).toContain("tab-select click failed")
      expect(String(caught)).toContain("targetHash=")
      expect(String(caught)).not.toContain("target-id")
      expect(waitCalls).toBe(1)
      expect(clickCalls).toBe(1)
      expect(finderCalls).toBe(0)
      const diagLine = logs.find((l) => l.includes("[probe] lifecycle-select"))
      expect(diagLine).toBeDefined()
      const payload = JSON.parse(diagLine!.slice(diagLine!.indexOf("{")))
      expect(payload.stage).toBe("click")
      expect(payload.clickAttempts).toBe(1)
    } finally {
      console.log = origLog
    }
  })

  it("first click failure detached then second click failure does not retry third: two waits/two clicks/one finder, sanitized second", async () => {
    const { selectLifecycleTab } = await import("../../script/e2e-probe-dom")
    let waitCalls = 0
    let clickCalls = 0
    let finderCalls = 0
    let detachedAfterFirstClick = false
    const logs: string[] = []
    const origLog = console.log
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "))
    }
    try {
      const origFrame: any = {
        isDetached: () => {
          if (clickCalls >= 1) return true
          return false
        },
        locator: () => ({
          first: () => ({
            waitFor: async () => {
              waitCalls++
            },
            click: async () => {
              clickCalls++
              if (clickCalls === 1) {
                detachedAfterFirstClick = true
                throw new Error("playwright click detached selector=.am-tab-sortable[data-tab-id=\"target-id\"] .am-tab-target")
              }
              throw new Error("playwright click detached")
            },
          }),
          count: async () => 1,
        }),
        evaluate: async () => "target-id",
      }
      void detachedAfterFirstClick
      const freshFrame: any = {
        isDetached: () => false,
        locator: () => ({
          first: () => ({
            waitFor: async () => {
              waitCalls++
            },
            click: async () => {
              clickCalls++
              throw new Error("playwright second click failure selector=.am-tab-sortable[data-tab-id=\"target-id\"]")
            },
          }),
          count: async () => 1,
        }),
        evaluate: async () => "target-id",
      }
      const browser: any = {
        contexts: () => {
          finderCalls++
          return [
            {
              pages: () => [
                {
                  frames: () => [
                    {
                      url: () => "https://vscode-webview.example.com/vs",
                      locator: freshFrame.locator,
                      evaluate: freshFrame.evaluate,
                      isDetached: freshFrame.isDetached,
                    },
                  ],
                  url: () => "https://vscode-webview.example.com",
                },
              ],
            },
          ]
        },
      }
      let caught: unknown
      try {
        await selectLifecycleTab(browser, origFrame as any, "target-id", 2000)
      } catch (e) {
        caught = e
      }
      expect(String(caught)).toContain("tab-select click failed")
      expect(String(caught)).toContain("targetHash=")
      expect(String(caught)).not.toContain("target-id")
      expect(waitCalls).toBe(2)
      expect(clickCalls).toBe(2)
      const clickDiags = logs.filter((l) => l.includes('"click"'))
      expect(clickDiags.length).toBeGreaterThanOrEqual(1)
    } finally {
      console.log = origLog
    }
    expect(finderCalls).toBe(1)
  })
})

describe("lifecycle tab target inner vs outer and redacted diagnostic", () => {
  it("click action uses inner .am-tab-target, outer only for read", () => {
    // inner target locator for action
    expect(domSrc).toContain('.am-tab-sortable[data-tab-id="${tabId}"] .am-tab-target')
    expect(domSrc).toContain("export async function waitForTabTarget")
    expect(domSrc).toContain("export async function clickVisibleTabTarget")
    // outer helpers remain for existence/order/read semantics
    const waitOuterIdx = domSrc.indexOf("export async function waitForTab(")
    const waitOuterSlice = domSrc.slice(waitOuterIdx, waitOuterIdx + 300)
    expect(waitOuterSlice).toContain('.am-tab-sortable[data-tab-id="${tabId}"]')
    expect(waitOuterSlice).not.toContain(".am-tab-target")
    const statesIdx = domSrc.indexOf("export async function tabStates")
    const statesSlice = domSrc.slice(statesIdx, statesIdx + 800)
    expect(statesSlice).toContain(".am-tab-sortable")
    expect(statesSlice).not.toContain(".am-tab-target")
    const activeIdx = domSrc.indexOf("export async function activeTabId")
    const activeSlice = domSrc.slice(activeIdx, activeIdx + 500)
    expect(activeSlice).toContain(".am-tab-sortable")
    // action helpers use inner via helper functions
    const clickTabIdx = domSrc.indexOf("export async function clickTab")
    const clickTabSlice = domSrc.slice(clickTabIdx, clickTabIdx + 1200)
    expect(clickTabSlice).toContain("waitForTabTarget")
    expect(clickTabSlice).toContain("clickVisibleTabTarget")
    expect(clickTabSlice).not.toContain("waitForTab(frame, tabId")
    const selIdx = domSrc.indexOf("export async function selectLifecycleTab")
    const selSlice = domSrc.slice(selIdx, selIdx + 7000)
    expect(selSlice).toContain("waitForTabTarget")
    expect(selSlice).toContain("clickVisibleTabTarget")
    // ensure inner locator appears in wait/click target helper definitions (not necessarily in selSlice)
    const wtIdx = domSrc.indexOf("export async function waitForTabTarget")
    const wtSlice = domSrc.slice(wtIdx, wtIdx + 300)
    expect(wtSlice).toContain(".am-tab-target")
    const ctIdx = domSrc.indexOf("export async function clickVisibleTabTarget")
    const ctSlice = domSrc.slice(ctIdx, ctIdx + 300)
    expect(ctSlice).toContain(".am-tab-target")
  })

  it("no direct outer .am-tab-sortable click without inner in lifecycle selection", () => {
    const selIdx = domSrc.indexOf("export async function selectLifecycleTab")
    const selSlice = domSrc.slice(selIdx, selIdx + 7000)
    // lifecycle selection must not call outer clickVisibleTab directly
    expect(selSlice).not.toMatch(/await clickVisibleTab\(cur, tabId/)
    expect(selSlice).not.toMatch(/await waitForTab\(cur, tabId/)
    // inner must be used
    expect(selSlice).toContain("clickVisibleTabTarget(cur, tabId")
    expect(selSlice).toContain("waitForTabTarget(cur, tabId")
    // file still has outer helper for existence but not used in lifecycle path; outer click helper must be deleted
    expect(domSrc).toContain("export async function waitForTab(")
    expect(domSrc).not.toContain("export async function clickVisibleTab(")
    expect(domSrc).not.toMatch(/export async function clickVisibleTab\(frame/)
    expect(domSrc).not.toContain("clickVisibleTab(frame")
    // clickTab also uses inner only
    const clickTabIdx = domSrc.indexOf("export async function clickTab")
    const clickTabSlice = domSrc.slice(clickTabIdx, clickTabIdx + 800)
    expect(clickTabSlice).not.toMatch(/await waitForTab\(frame, tabId/)
    expect(clickTabSlice).not.toMatch(/await clickVisibleTab\(frame, tabId/)
  })

  it("diagnostic is synchronous redacted hash/count/enum only with required fields", () => {
    expect(domSrc).toContain("lc-select-v1")
    expect(domSrc).toContain("LC_SELECT_VERSION")
    const selIdx = domSrc.indexOf("export async function selectLifecycleTab")
    const selSlice = domSrc.slice(selIdx, selIdx + 7000)
    expect(selSlice).toContain("targetHash")
    expect(selSlice).toContain("activeHash")
    expect(selSlice).toContain("stage")
    expect(selSlice).toContain("waitAttempts")
    expect(selSlice).toContain("clickAttempts")
    expect(selSlice).toContain("reacquires")
    expect(selSlice).toContain("detachedSeen")
    expect(selSlice).toContain("activePolls")
    expect(selSlice).toContain("remainingBucket")
    expect(selSlice).toContain("frameHash")
    expect(selSlice).toContain("[probe] lifecycle-select")
    expect(selSlice).toContain("console.log")
    expect(selSlice).toContain("lcHash")
    expect(selSlice).toContain("lcBucket")
    // no raw IDs/title/path/secret in diagnostic construction
    expect(selSlice).not.toContain("phase0.sessionId")
    expect(selSlice).not.toContain("GcLifecycle Title")
    expect(selSlice).not.toContain("realArtifact")
    // diagnostic must be synchronous: emit helper contains no await and no extra evaluate/finder
    const emitIdx = selSlice.indexOf("const emit")
    const emitSlice = selSlice.slice(emitIdx, emitIdx + 1200)
    expect(emitSlice).not.toContain("await ")
    expect(emitSlice).not.toContain("evaluate")
    expect(emitSlice).not.toContain("findAgentManagerFrameAny")
    // stage enum distinct for click/wait/poll/detach/deadline
    expect(selSlice).toContain('"wait"')
    expect(selSlice).toContain('"click"')
    expect(selSlice).toContain('"poll"')
    expect(selSlice).toContain('"detach"')
    expect(selSlice).toContain('"deadline"')
  })

  it("runtime diagnostic emits exact schema wait stage with 16hex hashes and bounded counts", async () => {
    const { createHash } = await import("node:crypto")
    const lcHash = (v: string) => createHash("sha256").update(v).digest("hex").slice(0, 16)
    const logs: string[] = []
    const origLog = console.log
    // eslint-disable-next-line no-console
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "))
    }
    const secret = "secret-tab-id-123"
    const expectedHash = lcHash(secret)
    try {
      const { selectLifecycleTab } = await import("../../script/e2e-probe-dom")
      const frame: any = {
        isDetached: () => false,
        locator: () => ({
          first: () => ({
            waitFor: async () => {
              throw new Error("playwright wait selector=.am-tab-sortable[data-tab-id=\"secret-tab-id-123\"] .am-tab-target")
            },
            click: async () => {},
          }),
          count: async () => 0,
        }),
        evaluate: async () => undefined,
      }
      const browser: any = { contexts: () => [] }
      let caught: unknown
      try {
        await selectLifecycleTab(browser, frame as any, secret, 600)
      } catch (e) {
        caught = e
      }
      expect(String(caught)).toContain("tab-select wait failed")
      expect(String(caught)).not.toContain(secret)
      const diagLine = logs.find((l) => l.includes("[probe] lifecycle-select"))
      expect(diagLine).toBeDefined()
      const jsonStr = diagLine!.slice(diagLine!.indexOf("{"))
      const payload = JSON.parse(jsonStr) as Record<string, unknown>
      const expectedKeys = ["v", "targetHash", "activeHash", "stage", "waitAttempts", "clickAttempts", "reacquires", "detachedSeen", "activePolls", "remainingBucket", "frameHash"]
      expect(Object.keys(payload).sort()).toEqual(expectedKeys.sort())
      expect(payload.v).toBe("lc-select-v1")
      expect(payload.targetHash).toBe(expectedHash)
      expect(payload.targetHash).toMatch(/^[0-9a-f]{16}$/)
      expect(payload.activeHash).toMatch(/^[0-9a-f]{16}$|^none$/)
      expect(payload.stage).toBe("wait")
      expect(["wait", "click", "poll", "detach", "deadline"]).toContain(payload.stage as string)
      expect(payload.waitAttempts).toBe(1)
      expect(payload.clickAttempts).toBe(0)
      for (const k of ["waitAttempts", "clickAttempts", "reacquires", "detachedSeen", "activePolls"] as const) {
        const v = payload[k] as number
        expect(Number.isInteger(v)).toBeTrue()
        expect(v).toBeGreaterThanOrEqual(0)
        expect(v).toBeLessThanOrEqual(10)
      }
      expect(["0", "lt1s", "lt5s", "ge5s"]).toContain(payload.remainingBucket as string)
      expect((payload.frameHash as string)).toMatch(/^[0-9a-f]{16}$|^none$/)
      expect(diagLine!).not.toContain(secret)
      expect(diagLine!).not.toContain("GcLifecycle Title")
      expect(String(caught)).not.toContain(secret)
    } finally {
      console.log = origLog
    }
  })

  it("runtime diagnostic click stage exact schema sanitized and multiple stages", async () => {
    const { createHash } = await import("node:crypto")
    const lcHash = (v: string) => createHash("sha256").update(v).digest("hex").slice(0, 16)
    const logs: string[] = []
    const origLog = console.log
    // eslint-disable-next-line no-console
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "))
    }
    const secret = "another-secret-hostile/title/path"
    const expectedHash = lcHash(secret)
    try {
      const { selectLifecycleTab } = await import("../../script/e2e-probe-dom")
      const frame: any = {
        isDetached: () => false,
        locator: () => ({
          first: () => ({
            waitFor: async () => {},
            click: async () => {
              throw new Error("playwright click selector=.am-tab-sortable[data-tab-id=\"another-secret-hostile/title/path\"] .am-tab-target")
            },
          }),
          count: async () => 0,
        }),
        evaluate: async () => undefined,
      }
      const browser: any = { contexts: () => [] }
      let caught: unknown
      try {
        await selectLifecycleTab(browser, frame as any, secret, 600)
      } catch (e) {
        caught = e
      }
      expect(String(caught)).toContain("tab-select click failed")
      expect(String(caught)).toContain("targetHash=")
      expect(String(caught)).not.toContain(secret)
      expect(String(caught)).not.toContain("hostile")
      const diagLines = logs.filter((l) => l.includes("[probe] lifecycle-select"))
      expect(diagLines.length).toBeGreaterThanOrEqual(1)
      const last = diagLines[diagLines.length - 1]!
      const payload = JSON.parse(last.slice(last.indexOf("{"))) as Record<string, unknown>
      expect(payload.v).toBe("lc-select-v1")
      expect(payload.targetHash).toBe(expectedHash)
      expect(payload.stage).toBe("click")
      expect(payload.clickAttempts).toBe(1)
      expect(payload.waitAttempts).toBe(1)
      for (const k of ["waitAttempts", "clickAttempts", "reacquires", "detachedSeen", "activePolls"] as const) {
        expect(Number.isInteger(payload[k] as number)).toBeTrue()
      }
      expect(last).not.toContain(secret)
      expect(last).not.toContain("path")
    } finally {
      console.log = origLog
    }
  })

  it("runtime diagnostic deadline stage hostile payload absent", async () => {
    const { createHash } = await import("node:crypto")
    const lcHash = (v: string) => createHash("sha256").update(v).digest("hex").slice(0, 16)
    const logs: string[] = []
    const origLog = console.log
    // eslint-disable-next-line no-console
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "))
    }
    const secret = "deadline-secret-xyz"
    const hostileActive = "active-evil-title"
    try {
      const { selectLifecycleTab } = await import("../../script/e2e-probe-dom")
      const frame: any = {
        isDetached: () => false,
        locator: () => ({
          first: () => ({
            waitFor: async () => {},
            click: async () => {},
          }),
          count: async () => 0,
        }),
        evaluate: async () => hostileActive,
      }
      const browser: any = { contexts: () => [] }
      let caught = ""
      try {
        await selectLifecycleTab(browser, frame as any, secret, 50)
      } catch (e) {
        caught = String(e)
      }
      expect(caught).toContain("tab-select deadline")
      expect(caught).not.toContain(secret)
      expect(caught).not.toContain(hostileActive)
      const diagLine = logs.find((l) => l.includes("[probe] lifecycle-select") && l.includes('"deadline"'))
      expect(diagLine).toBeDefined()
      const payload = JSON.parse(diagLine!.slice(diagLine!.indexOf("{"))) as Record<string, unknown>
      expect(payload.stage).toBe("deadline")
      expect(payload.targetHash).toBe(lcHash(secret))
      expect(payload.activeHash).toMatch(/^[0-9a-f]{16}$/)
      expect(diagLine!).not.toContain(secret)
      expect(diagLine!).not.toContain(hostileActive)
    } finally {
      console.log = origLog
    }
  })

  it("selectors exact inner for wait/click actions across attached/detached paths", async () => {
    const { selectLifecycleTab } = await import("../../script/e2e-probe-dom")
    const inner = '.am-tab-sortable[data-tab-id="target-id"] .am-tab-target'
    const outer = '.am-tab-sortable[data-tab-id="target-id"]'
    const makeHarness = (opts: { detachedInitial: boolean; failWait: boolean; failClick: boolean }) => {
      const selectors: string[] = []
      let isDetachedFirst = opts.detachedInitial
      let clickFailedOnce = false
      const frame: any = {
        isDetached: () => {
          if (isDetachedFirst) {
            isDetachedFirst = false
            return true
          }
          if (opts.failClick && !clickFailedOnce) return false
          return false
        },
        locator: (sel: string) => {
          selectors.push(sel)
          if (sel === ".am-layout") return { count: async () => 1 } as any
          return {
            first: () => ({
              waitFor: async () => {
                if (opts.failWait) throw new Error("wait fail")
              },
              click: async () => {
                if (opts.failClick && !clickFailedOnce) {
                  clickFailedOnce = true
                  throw new Error("click fail")
                }
              },
            }),
          } as any
        },
        evaluate: async () => "target-id",
      }
      const fresh: any = {
        isDetached: () => false,
        locator: (sel: string) => {
          selectors.push(sel)
          return {
            first: () => ({
              waitFor: async () => {},
              click: async () => {},
            }),
            count: async () => 1,
          } as any
        },
        evaluate: async () => "target-id",
      }
      const browser: any = {
        contexts: () => [
          {
            pages: () => [
              {
                frames: () => [
                  {
                    url: () => "https://vscode-webview.example.com/vs",
                    locator: fresh.locator,
                    evaluate: fresh.evaluate,
                    isDetached: fresh.isDetached,
                  },
                ],
                url: () => "https://vscode-webview.example.com",
              },
            ],
          },
        ],
      }
      return { selectors, frame, browser }
    }
    // attached success path completes without throw
    {
      const { selectors, frame, browser } = makeHarness({ detachedInitial: false, failWait: false, failClick: false })
      await selectLifecycleTab(browser, frame as any, "target-id", 1000)
      const actionSelectors = selectors.filter((s) => s.includes(".am-tab-sortable"))
      expect(actionSelectors.length).toBeGreaterThanOrEqual(2)
      for (const sel of actionSelectors) expect(sel).toBe(inner)
      expect(selectors.some((s) => s === outer)).toBeFalse()
      expect(selectors.every((s) => !s.includes("secret"))).toBeTrue()
    }
    // detached initial success path completes without throw
    {
      const { selectors, frame, browser } = makeHarness({ detachedInitial: true, failWait: false, failClick: false })
      await selectLifecycleTab(browser, frame as any, "target-id", 1000)
      const innerOnly = selectors.filter((s) => s === inner)
      expect(innerOnly.length).toBeGreaterThanOrEqual(2)
      expect(selectors.some((s) => s === outer)).toBeFalse()
      expect(selectors.every((s) => !s.includes("secret"))).toBeTrue()
    }
    // failWait: throws sanitized wait stage, every action selector exact inner, no outer
    {
      const { selectors, frame, browser } = makeHarness({ detachedInitial: false, failWait: true, failClick: false })
      let err = ""
      try {
        await selectLifecycleTab(browser, frame as any, "target-id", 1000)
      } catch (e) {
        err = String(e)
      }
      expect(err).toContain("tab-select wait failed")
      expect(err).toContain("targetHash=")
      expect(err).not.toContain("target-id")
      const actionSelectors = selectors.filter((s) => s.includes(".am-tab-sortable"))
      expect(actionSelectors.length).toBeGreaterThanOrEqual(1)
      for (const sel of actionSelectors) expect(sel).toBe(inner)
      expect(selectors.some((s) => s === outer)).toBeFalse()
    }
    // failClick: throws sanitized click stage, every action selector exact inner, no outer
    {
      const { selectors, frame, browser } = makeHarness({ detachedInitial: false, failWait: false, failClick: true })
      let err = ""
      try {
        await selectLifecycleTab(browser, frame as any, "target-id", 1000)
      } catch (e) {
        err = String(e)
      }
      expect(err).toContain("tab-select click failed")
      expect(err).toContain("targetHash=")
      expect(err).not.toContain("target-id")
      const actionSelectors = selectors.filter((s) => s.includes(".am-tab-sortable"))
      expect(actionSelectors.length).toBeGreaterThanOrEqual(2)
      for (const sel of actionSelectors) expect(sel).toBe(inner)
      expect(selectors.some((s) => s === outer)).toBeFalse()
    }
  })

  it("outer selector only read/existence if applicable", () => {
    expect(domSrc).toContain('.am-tab-sortable[data-tab-id')
    // tabStates and activeTabId use outer for order/read anchor
    const statesIdx = domSrc.indexOf("export async function tabStates")
    const statesSlice = domSrc.slice(statesIdx, statesIdx + 800)
    expect(statesSlice).toContain(".am-tab-sortable")
    expect(statesSlice).not.toContain(".am-tab-target")
    const activeIdx = domSrc.indexOf("export async function activeTabId")
    const activeSlice = domSrc.slice(activeIdx, activeIdx + 500)
    expect(activeSlice).toContain(".am-tab-sortable")
    // waitForTab outer helper remains for existence but not used in lifecycle action
    expect(domSrc).toContain("export async function waitForTab(")
    const selIdx = domSrc.indexOf("export async function selectLifecycleTab")
    const selSlice = domSrc.slice(selIdx, selIdx + 7000)
    expect(selSlice).not.toMatch(/await waitForTab\(cur, tabId/)
  })
})
