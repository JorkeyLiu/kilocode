import { expect, test } from "@playwright/test"

test("canonical settings keep unsupported controls read-only and diagnostics visible", async ({ page }) => {
  const messages: unknown[] = []
  await page.exposeFunction("recordWebviewMessage", (message: unknown) => messages.push(message))
  await page.addInitScript(() => {
    window.addEventListener("kilo-webview-message", (event) => {
      void (window as unknown as { recordWebviewMessage?: (message: unknown) => void }).recordWebviewMessage?.((event as CustomEvent).detail)
    })
  })
  await page.goto("/iframe.html?id=settings--canonical-interaction&viewMode=story")
  await expect(page.getByTestId("canonical-diagnostics")).toBeVisible()
  await page.getByTestId("canonical-unsupported-controls").hover()
  const controls = page.getByTestId("canonical-unsupported-controls").locator("input[disabled], button[disabled]")
  const count = await controls.count()
  expect(count).toBeGreaterThan(0)
  for (let index = 0; index < Math.min(count, 4); index++) await expect(controls.nth(index)).toBeDisabled()
  expect(messages.filter((message) => typeof message === "object" && message !== null && ["updateConfig", "updateSetting", "connectProvider", "saveCustomProvider", "mutateAgent"].includes((message as { type?: string }).type ?? ""))).toEqual([])
})

test("canonical settings keep UI-local font size writable", async ({ page }) => {
  const messages: unknown[] = []
  await page.exposeFunction("recordWebviewMessage", (message: unknown) => messages.push(message))
  await page.addInitScript(() => {
    window.addEventListener("kilo-webview-message", (event) => {
      void (window as unknown as { recordWebviewMessage?: (message: unknown) => void }).recordWebviewMessage?.((event as CustomEvent).detail)
    })
  })
  await page.goto("/iframe.html?id=settings--canonical-interaction&viewMode=story")
  const slider = page.getByTestId("canonical-unsupported-controls").locator('input[type="range"]')
  await slider.fill("18")
  expect(messages).toContainEqual(expect.objectContaining({ type: "updateSetting", key: "fontSize", value: 18 }))
})

test("canonical settings expose native disabled controls", async ({ page }) => {
  await page.goto("/iframe.html?id=settings--canonical-interaction&viewMode=story")
  await expect(page.getByTestId("canonical-diagnostics")).toBeVisible()
  await expect(page.locator("input[disabled], button[disabled]").count()).toBeGreaterThan(0)
  await expect(page.getByTestId("canonical-unsupported-controls")).toContainText("read-only")
})

test("custom-only mixed legacy+canonical hides legacy npm row and keeps canonical row interactive", async ({
  page,
}) => {
  const messages: unknown[] = []
  await page.exposeFunction("recordWebviewMessage", (message: unknown) => messages.push(message))
  await page.addInitScript(() => {
    window.addEventListener("kilo-webview-message", (event) => {
      void (window as unknown as { recordWebviewMessage?: (message: unknown) => void }).recordWebviewMessage?.((event as CustomEvent).detail)
    })
  })
  await page.goto("/iframe.html?id=settings--providers-custom-only-mixed-legacy&viewMode=story")
  const canonicalRow = page.locator(".settings-provider-row", { hasText: "Acme Custom" })
  await expect(canonicalRow).toBeVisible()
  await expect(canonicalRow.getByText("Custom", { exact: true })).toBeVisible()
  await expect(page.getByText("Legacy NPM", { exact: true })).toHaveCount(0)
  await expect(page.locator(".settings-provider-row", { hasText: "Legacy NPM" })).toHaveCount(0)

  const edit = canonicalRow.getByRole("button", { name: "Edit" })
  await expect(edit).toBeVisible()
  await edit.click()
  await expect(page.getByText("Edit provider")).toBeVisible()

  const legacyRefs = messages.filter((message) => JSON.stringify(message).includes("legacy-npm"))
  expect(legacyRefs).toEqual([])
  expect(
    messages.filter(
      (message) =>
        typeof message === "object" &&
        message !== null &&
        ["updateConfig", "connectProvider"].includes((message as { type?: string }).type ?? ""),
    ),
  ).toEqual([])
})
