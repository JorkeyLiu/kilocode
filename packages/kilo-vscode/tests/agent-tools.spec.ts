import { expect, test } from "@playwright/test"

const STORY_ID = "settings--mode-edit-tools"
const GLOBALS = "colorScheme:dark;theme:kilo-vscode;vscodeTheme:dark-modern"

async function lastPatch(page: import("@playwright/test").Page) {
  const raw = await page.locator('[data-testid="agent-tools-last-patch"]').evaluate((el) => el.textContent ?? "{}")
  return JSON.parse(raw || "{}") as { name?: string; patch?: { frontmatter?: Record<string, unknown>; body?: string } }
}

async function lastWire(page: import("@playwright/test").Page) {
  const raw = await page.locator('[data-testid="agent-tools-last-wire"]').evaluate((el) => el.textContent ?? "{}")
  return JSON.parse(raw || "{}") as { name?: string; frontmatter?: Record<string, unknown>; body?: string }
}

async function wireFrontmatter(page: import("@playwright/test").Page) {
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="agent-tools-last-wire"]')
      if (!el) return false
      try {
        const data = JSON.parse(el.textContent ?? "{}") as { frontmatter?: Record<string, unknown> }
        return !!data.frontmatter && !("tools" in data.frontmatter)
      } catch {
        return false
      }
    },
    undefined,
    { timeout: 5000 },
  )
  return (await lastWire(page)).frontmatter ?? {}
}

test("agent tools disable/restore only touches the selected agent tools record", async ({ page }) => {
  await page.setViewportSize({ width: 480, height: 800 })
  await page.goto(`/iframe.html?id=${STORY_ID}&viewMode=story&globals=${GLOBALS}`, { waitUntil: "load" })
  await page.waitForSelector("#storybook-root *", { state: "attached" })

  const section = page.locator('[data-testid="agent-tools"]')
  await expect(section).toBeVisible()

  const bash = page.getByRole("switch", { name: "bash" })
  const edit = page.getByRole("switch", { name: "edit" })
  const custom = page.getByRole("switch", { name: "my-mcp-tool" })
  await expect(bash).toBeVisible()
  await expect(edit).toBeVisible()
  await expect(custom).toBeVisible()
  await expect(bash).not.toBeChecked()
  await expect(edit).toBeChecked()
  await expect(custom).not.toBeChecked()

  // Restore bash: removes only the bash key, keeps edit:true + custom false.
  // Kobalte switch input is visually hidden; click the visible control like other specs do.
  await page.locator('[data-testid="agent-tool-bash"] [data-slot="switch-control"]').click()
  await expect(bash).toBeChecked()
  let sent = await lastPatch(page)
  expect(sent.name).toBe("reviewer")
  expect(sent.patch?.frontmatter).toEqual({ tools: { edit: true, "my-mcp-tool": false } })
  expect(sent.patch?.frontmatter).not.toHaveProperty("permission")

  // Disable edit: sets false, preserves the custom entry.
  await page.locator('[data-testid="agent-tool-edit"] [data-slot="switch-control"]').click()
  await expect(edit).not.toBeChecked()
  sent = await lastPatch(page)
  expect(sent.name).toBe("reviewer")
  expect(sent.patch?.frontmatter).toEqual({ tools: { edit: false, "my-mcp-tool": false } })

  // Custom plugin/MCP tool name can be added as disabled.
  await page.getByPlaceholder("e.g. my-mcp-tool").fill("extra-plugin-tool")
  await page.getByTestId("agent-tool-add").click()
  const extra = page.getByRole("switch", { name: "extra-plugin-tool" })
  await expect(extra).toBeVisible()
  await expect(extra).not.toBeChecked()
  sent = await lastPatch(page)
  expect(sent.name).toBe("reviewer")
  const tools = sent.patch?.frontmatter?.["tools"] as Record<string, unknown>
  expect(tools["extra-plugin-tool"]).toBe(false)
  expect(tools["my-mcp-tool"]).toBe(false)
  expect(tools["edit"]).toBe(false)
  expect(sent.patch?.frontmatter).not.toHaveProperty("permission")
})

test("agent tools alias and wildcard display with surgical recovery", async ({ page }) => {
  const story = "settings--mode-edit-tools-alias-wildcard"
  await page.setViewportSize({ width: 480, height: 800 })
  await page.goto(`/iframe.html?id=${story}&viewMode=story&globals=${GLOBALS}`, { waitUntil: "load" })
  await page.waitForSelector("#storybook-root *", { state: "attached" })
  const section = page.locator('[data-testid="agent-tools"]')
  await expect(section).toBeVisible()

  const apply = section.getByRole("switch", { name: "apply_patch" })
  const build = section.getByRole("switch", { name: "build" })
  const wild = section.getByRole("switch", { name: "* (all tools)" })
  const custom = section.getByRole("switch", { name: "my-mcp-tool" })
  const bash = section.getByRole("switch", { name: "bash" })
  const edit = section.getByRole("switch", { name: "edit" })
  await expect(apply).not.toBeChecked()
  await expect(build).not.toBeChecked()
  await expect(wild).not.toBeChecked()
  await expect(custom).not.toBeChecked()
  await expect(bash).not.toBeChecked()
  await expect(edit).not.toBeChecked()
  await expect(section.getByRole("switch", { name: "patch", exact: true })).toHaveCount(0)
  await expect(section.getByRole("switch", { name: "code", exact: true })).toHaveCount(0)

  // Recover wildcard first so later specific recoveries delete only their alias keys.
  // Enabling "*" removes only that entry; the row disappears and wildcard-held
  // tools (bash) recover without touching specific alias disables.
  await page.locator('[data-testid="agent-tool-*"] [data-slot="switch-control"]').click()
  await expect(section.getByRole("switch", { name: "* (all tools)" })).toHaveCount(0)
  await expect(bash).toBeChecked()
  await expect(apply).not.toBeChecked()
  await page.locator('[data-testid="agent-tool-apply_patch"] [data-slot="switch-control"]').click()
  await expect(apply).toBeChecked()
  await expect(edit).toBeChecked()
  // `build`/`my-mcp-tool` are custom rows: recovery removes the authored key,
  // so the row disappears instead of flipping to checked.
  await page.locator('[data-testid="agent-tool-build"] [data-slot="switch-control"]').click()
  await expect(section.getByRole("switch", { name: "build", exact: true })).toHaveCount(0)
  await page.locator('[data-testid="agent-tool-my-mcp-tool"] [data-slot="switch-control"]').click()
  await expect(section.getByRole("switch", { name: "my-mcp-tool" })).toHaveCount(0)

  const front = await wireFrontmatter(page)
  expect(front).not.toHaveProperty("tools")
  expect(front).not.toHaveProperty("permission")
  const patch = await lastPatch(page)
  expect(patch.patch?.frontmatter).not.toHaveProperty("permission")
})

test("agent tools last-key recovery clears serialized frontmatter via the real coordinator", async ({
  page,
}) => {
  await page.setViewportSize({ width: 480, height: 800 })
  await page.goto(`/iframe.html?id=${STORY_ID}&viewMode=story&globals=${GLOBALS}`, { waitUntil: "load" })
  await page.waitForSelector("#storybook-root *", { state: "attached" })
  await expect(page.locator('[data-testid="agent-tools"]')).toBeVisible()

  const bash = page.getByRole("switch", { name: "bash" })
  const edit = page.getByRole("switch", { name: "edit" })
  await expect(bash).not.toBeChecked()
  await expect(edit).toBeChecked()

  await page.locator('[data-testid="agent-tool-bash"] [data-slot="switch-control"]').click()
  await expect(bash).toBeChecked()
  await page.locator('[data-testid="agent-tool-my-mcp-tool"] [data-slot="switch-control"]').click()
  await expect(page.getByRole("switch", { name: "my-mcp-tool" })).toHaveCount(0)

  // Disable then recover the last remaining authored key; the serialized
  // frontmatter must drop `tools` instead of retaining `false`.
  await page.locator('[data-testid="agent-tool-edit"] [data-slot="switch-control"]').click()
  await expect(edit).not.toBeChecked()
  await page.locator('[data-testid="agent-tool-edit"] [data-slot="switch-control"]').click()
  await expect(edit).toBeChecked()

  const front = await wireFrontmatter(page)
  expect(front).not.toHaveProperty("tools")
})
