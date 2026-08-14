/**
 * Formal interaction regression tests for P1 derived Topic navigation
 * (SidebarSessionList, stories in agent-manager.stories.tsx).
 *
 * Drives the real component through Storybook iframe stories with Playwright
 * — the repository's existing component-interaction layer (same pattern as
 * accessibility.spec.ts). Covers the four accepted P1 audit findings:
 *
 * 1. Auto-expand only fires when the active session or its Topic changes — a
 *    manual collapse survives unrelated session inventory updates.
 * 2. (Filter dead code was removed — asserted by the arch test, not here.)
 * 3. Topic disclosure aria labels resolve through i18n (asserted via the
 *    localized accessible name "Expand topic"/"Collapse topic").
 * 4. Topic/child selection, expand/collapse + aria-expanded, active-child
 *    topic highlighting, root rename relabel, and root deletion degrading
 *    children to orphan Topics.
 *
 * No visual baselines are produced here; stories are auto-discovered by the
 * existing visual regression suite.
 */

import { expect, test, type Page } from "@playwright/test"

const GLOBALS = "colorScheme:dark;theme:kilo-vscode;vscodeTheme:dark-modern"

function url(id: string) {
  return `/iframe.html?id=${id}&viewMode=story&globals=${GLOBALS}`
}

async function open(page: Page, id: string) {
  await page.goto(url(id), { waitUntil: "load" })
  await page.waitForSelector("#storybook-root [data-topic-id]", { state: "attached" })
}

const HIERARCHY = "agentmanager--topic-list-hierarchy"
const ORPHAN_CYCLE = "agentmanager--topic-list-orphan-cycle"
const INTERACTIONS = "agentmanager--topic-list-interactions"
const AUTO_EXPAND = "agentmanager--topic-list-auto-expand"

test("topic and child selection route through onSelectSession", async ({ page }) => {
  await open(page, HIERARCHY)

  const out = page.getByTestId("topic-selection")
  // Topic row (root session) selection
  await page.locator('[data-sidebar-id="topic-active"]').click()
  await expect(out).toHaveText("topic-active")
  // Child session selection
  await page.locator('[data-sidebar-id="topic-active-child"]').click()
  await expect(out).toHaveText("topic-active-child")
  // Grandchild requires expanding the child disclosure first
  await page.locator('[data-sidebar-id="topic-active-child"]').getByRole("button", { name: "Expand children" }).click()
  await page.locator('[data-sidebar-id="topic-active-grandchild"]').click()
  await expect(out).toHaveText("topic-active-grandchild")
})

test("topic disclosure toggles aria-expanded and children", async ({ page }) => {
  await open(page, HIERARCHY)

  const activeRow = page.locator('[data-topic-id="topic-active"]')
  const disclosure = activeRow.getByRole("button", { name: "Collapse topic" })

  // Active topic is auto-expanded on mount (activeId = topic-active-child).
  await expect(disclosure).toHaveAttribute("aria-expanded", "true")
  await expect(page.locator('[data-sidebar-id="topic-active-child"]')).toBeVisible()

  await disclosure.click()
  await expect(activeRow.getByRole("button", { name: "Expand topic" })).toHaveAttribute("aria-expanded", "false")
  await expect(page.locator('[data-sidebar-id="topic-active-child"]')).toBeHidden()

  await activeRow.getByRole("button", { name: "Expand topic" }).click()
  await expect(activeRow.getByRole("button", { name: "Collapse topic" })).toHaveAttribute("aria-expanded", "true")
  await expect(page.locator('[data-sidebar-id="topic-active-child"]')).toBeVisible()

  // Child-level disclosure independently toggles the grandchild.
  const childRow = page.locator('[data-sidebar-id="topic-active-child"]')
  await childRow.getByRole("button", { name: "Expand children" }).click()
  await expect(page.locator('[data-sidebar-id="topic-active-grandchild"]')).toBeVisible()
  await childRow.getByRole("button", { name: "Collapse children" }).click()
  await expect(page.locator('[data-sidebar-id="topic-active-grandchild"]')).toBeHidden()
})

test("active child highlights its Topic root row", async ({ page }) => {
  await open(page, HIERARCHY)

  // activeId = "topic-active-child" → its Topic root "topic-active" is active.
  await expect(page.locator('[data-topic-id="topic-active"]')).toHaveClass(/am-item-active/)
  // An unrelated Topic root is not highlighted.
  await expect(page.locator('[data-topic-id="topic-stale"]')).not.toHaveClass(/am-item-active/)
  // The active child row itself is highlighted too.
  await expect(page.locator('[data-sidebar-id="topic-active-child"]')).toHaveClass(/am-item-active/)
})

test("renaming a Topic root relabels the Topic", async ({ page }) => {
  await open(page, INTERACTIONS)

  // Action buttons are hover-revealed (production pattern) — hover first.
  const row = page.locator('[data-topic-id="topic-active"]')
  await row.hover()
  await row.getByRole("button", { name: "Rename: Refactor agent manager sidebar" }).click()
  const input = page.getByRole("textbox", { name: "Rename" })
  await expect(input).toBeVisible()
  await input.fill("Renamed sidebar topic")
  await input.press("Enter")

  await expect(row.locator(".am-item-title-text")).toHaveText("Renamed sidebar topic")
  // Topic identity is the root session ID — unchanged by rename.
  await expect(row).toHaveAttribute("data-topic-id", "topic-active")
})

test("deleting a Topic root degrades its children to orphan Topics", async ({ page }) => {
  await open(page, INTERACTIONS)

  // Action buttons are hover-revealed (production pattern) — hover first.
  const stale = page.locator('[data-topic-id="topic-stale"]')
  await stale.hover()
  await stale.getByRole("button", { name: "Delete session: Investigate provider routing" }).click()
  await page.getByRole("button", { name: "Delete session", exact: true }).click()

  // The deleted root's Topic disappears.
  await expect(page.locator('[data-topic-id="topic-stale"]')).toHaveCount(0)
  // Its child becomes an independent orphan Topic root.
  const orphan = page.locator('[data-topic-id="topic-stale-child"]')
  await expect(orphan).toHaveCount(1)
  await expect(orphan).toHaveClass(/am-topic-root/)
  await expect(orphan.locator(".am-item-title-text")).toHaveText("Trace SSE events")
})

test("orphan and cycle sessions degrade to independent Topic roots", async ({ page }) => {
  await open(page, ORPHAN_CYCLE)

  // Orphan (missing parent) becomes its own Topic root; active in this story.
  await expect(page.locator('[data-topic-id="orphan"]')).toHaveClass(/am-topic-root/)
  await expect(page.locator('[data-topic-id="orphan"]')).toHaveClass(/am-item-active/)
  // Cycle members never become one Topic — each is an independent root.
  await expect(page.locator('[data-topic-id="cycle-a"]')).toHaveCount(1)
  await expect(page.locator('[data-topic-id="cycle-b"]')).toHaveCount(1)
})

test("manual collapse survives inventory updates; active change auto-expands", async ({ page }) => {
  await open(page, AUTO_EXPAND)

  const activeDisclosure = page.locator('[data-topic-id="topic-active"] .am-session-expand-toggle')
  const staleDisclosure = page.locator('[data-topic-id="topic-stale"] .am-session-expand-toggle')

  // Initial: active Topic (topic-active) auto-expanded.
  await expect(activeDisclosure).toHaveAttribute("aria-expanded", "true")
  await expect(page.locator('[data-sidebar-id="topic-active-child"]')).toBeVisible()

  // User manually collapses it.
  await activeDisclosure.click()
  await expect(activeDisclosure).toHaveAttribute("aria-expanded", "false")
  await expect(page.locator('[data-sidebar-id="topic-active-child"]')).toBeHidden()

  // Session inventory update on the SAME active session/topic must not reopen it.
  await page.getByTestId("refresh-inventory").click()
  await expect(activeDisclosure).toHaveAttribute("aria-expanded", "false")
  await expect(page.locator('[data-sidebar-id="topic-active-child"]')).toBeHidden()

  // Active session moves to another Topic → that Topic auto-expands.
  await page.getByTestId("activate-stale").click()
  await expect(staleDisclosure).toHaveAttribute("aria-expanded", "true")
  await expect(page.locator('[data-sidebar-id="topic-stale-child"]')).toBeVisible()

  // The manually collapsed Topic stays collapsed through the active change.
  await expect(activeDisclosure).toHaveAttribute("aria-expanded", "false")
})
