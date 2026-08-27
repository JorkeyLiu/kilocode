import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import { mkdir, mkdtemp, rm, stat, writeFile } from "fs/promises"
import * as os from "os"
import * as path from "path"
import * as vscode from "vscode"
import { globalFiles, localFiles } from "../../src/kilo-provider/config-file"
import { openConfig } from "../../src/kilo-provider/open-config"

type Uri = { fsPath: string }

const dirs: string[] = []

const env = {
  HOME: process.env.HOME,
  KILO_CONFIG: process.env.KILO_CONFIG,
  KILO_CONFIG_CONTENT: process.env.KILO_CONFIG_CONTENT,
  KILO_CONFIG_DIR: process.env.KILO_CONFIG_DIR,
  KILO_DISABLE_PROJECT_CONFIG: process.env.KILO_DISABLE_PROJECT_CONFIG,
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
}

const labels = {
  noWorkspace: "No workspace",
  openFailed: "Open failed: {{message}}",
  placeholder: "Choose config",
  scope: "Scope",
  sourceGlobal: "Global",
  sourceLocal: "Local",
  statusCreate: "Create",
  statusLoaded: "Loaded",
  statusNotLoaded: "Not loaded",
  title: "Open config",
}

const win = vscode.window as unknown as {
  showErrorMessage: ReturnType<typeof mock>
  showQuickPick: ReturnType<typeof mock>
  showTextDocument: ReturnType<typeof mock>
  showWarningMessage: ReturnType<typeof mock>
}

const workspace = vscode.workspace as unknown as {
  fs: {
    createDirectory: (uri: Uri) => Promise<void>
    stat: (uri: Uri) => Promise<{ type: number; ctime: number; mtime: number; size: number }>
    writeFile: (uri: Uri, data: Uint8Array) => Promise<void>
  }
  openTextDocument: ReturnType<typeof mock>
}

async function temp() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "kilo-config-"))
  dirs.push(dir)
  return dir
}

async function file(name: string, body = "{}") {
  await mkdir(path.dirname(name), { recursive: true })
  await writeFile(name, body)
}

function restore() {
  for (const key of Object.keys(env) as Array<keyof typeof env>) {
    const value = env[key]
    if (value === undefined) delete process.env[key]
    if (value !== undefined) process.env[key] = value
  }
}

function reset() {
  win.showErrorMessage = mock(async () => undefined)
  win.showQuickPick = mock(async (items: Array<{ item: unknown }>) => items[0])
  win.showTextDocument = mock(async () => undefined)
  win.showWarningMessage = mock(async () => undefined)
  workspace.openTextDocument = mock(async (uri: Uri) => ({ uri }))
  workspace.fs.createDirectory = async (uri) => {
    await mkdir(uri.fsPath, { recursive: true })
  }
  workspace.fs.stat = async (uri) => {
    const meta = await stat(uri.fsPath)
    return { type: 1, ctime: meta.ctimeMs, mtime: meta.mtimeMs, size: meta.size }
  }
  workspace.fs.writeFile = async (uri, data) => {
    await file(uri.fsPath, Buffer.from(data).toString())
  }
}

afterEach(async () => {
  restore()
  reset()
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe("config file discovery", () => {
  it("global resolves to single kilo.jsonc at resolved global root and ignores legacy sources", async () => {
    reset()
    const root = await temp()
    const xdg = path.join(root, "xdg")
    const home = path.join(root, "home")
    const spy = spyOn(os, "homedir").mockReturnValue(home)
    try {
      process.env.HOME = home
      process.env.XDG_CONFIG_HOME = xdg
      delete process.env.KILO_CONFIG
      delete process.env.KILO_CONFIG_CONTENT
      delete process.env.KILO_CONFIG_DIR
      // legacy files that must be ignored as non-canonical authorities
      await file(path.join(xdg, "kilo", "kilo.json"))
      await file(path.join(xdg, "kilo", "config.json"))
      await file(path.join(home, ".kilo", "kilo.jsonc"))
      await file(path.join(home, ".kilocode", "opencode.json"))
      await file(path.join(home, ".opencode", "kilo.jsonc"))
      await file(path.join(root, "env.jsonc"))

      const list = globalFiles()

      expect(list.length).toBe(1)
      expect(list[0].source).toBe("sourceGlobal")
      expect(list[0].file).toBe(path.join(xdg, "kilo", "kilo.jsonc"))
      expect(list[0].name).toBe("kilo.jsonc")
      expect((list[0] as unknown as Record<string, unknown>).legacy).toBeUndefined()
      expect((list[0] as unknown as Record<string, unknown>).virtual).toBeUndefined()
      expect(list[0].recommended).toBe(true)
      // must not surface legacy filenames or alternative dirs
      expect(list.some((item) => item.file?.endsWith("kilo.json"))).toBe(false)
      expect(list.some((item) => item.file?.includes(".kilocode"))).toBe(false)
      expect(list.some((item) => item.file?.includes(".opencode"))).toBe(false)
    } finally {
      spy.mockRestore()
    }
  })

  it("global respects KILO_CONFIG_DIR as resolved global root", async () => {
    reset()
    const root = await temp()
    const xdg = path.join(root, "xdg")
    const extra = path.join(root, "extra")
    const home = path.join(root, "home")
    const spy = spyOn(os, "homedir").mockReturnValue(home)
    try {
      process.env.HOME = home
      process.env.XDG_CONFIG_HOME = xdg
      process.env.KILO_CONFIG_DIR = extra
      await file(path.join(extra, "kilo.jsonc"))

      const list = globalFiles()

      expect(list.length).toBe(1)
      expect(list[0].file).toBe(path.join(extra, "kilo.jsonc"))
      expect(list[0].source).toBe("sourceGlobal")
      expect(list[0].exists).toBe(true)
    } finally {
      spy.mockRestore()
    }
  })

  it("global creates recommended entry when file does not exist, still via KILO_CONFIG_DIR root", async () => {
    reset()
    const root = await temp()
    const extra = path.join(root, "extra")
    const home = path.join(root, "home")
    const spy = spyOn(os, "homedir").mockReturnValue(home)
    try {
      process.env.HOME = home
      process.env.KILO_CONFIG_DIR = extra
      delete process.env.XDG_CONFIG_HOME

      const list = globalFiles()

      expect(list.length).toBe(1)
      expect(list[0].file).toBe(path.join(extra, "kilo.jsonc"))
      expect(list[0].exists).toBe(false)
      expect(list[0].recommended).toBe(true)
    } finally {
      spy.mockRestore()
    }
  })

  it("local resolves only to workspace .kilo/kilo.jsonc and ignores legacy project files", async () => {
    reset()
    const root = await temp()
    await file(path.join(root, "kilo.json"))
    await file(path.join(root, "kilo.jsonc"))
    await file(path.join(root, ".kilocode", "kilo.jsonc"))
    await file(path.join(root, ".opencode", "opencode.json"))
    await file(path.join(root, ".kilo", "opencode.jsonc"))
    // canonical file missing, but we already test ignores

    const list = localFiles(root)

    expect(list.length).toBe(1)
    expect(list[0].file).toBe(path.join(root, ".kilo", "kilo.jsonc"))
    expect(list[0].source).toBe("sourceLocal")
    expect(list[0].recommended).toBe(true)
    expect(list.some((item) => item.file?.includes(`${path.sep}.kilocode${path.sep}`))).toBe(false)
    expect(list.some((item) => item.file?.includes(`${path.sep}.opencode${path.sep}`))).toBe(false)
    expect(list.some((item) => item.file === path.join(root, "kilo.jsonc"))).toBe(false)
  })

  it("local reports existing canonical file with exists true", async () => {
    reset()
    const root = await temp()
    const cfg = path.join(root, ".kilo", "kilo.jsonc")
    await file(cfg)

    const list = localFiles(root)

    expect(list.length).toBe(1)
    expect(list[0].file).toBe(cfg)
    expect(list[0].exists).toBe(true)
    expect(list[0].loaded).toBe(true)
    expect(list[0].source).toBe("sourceLocal")
  })

  it("marks project file not loaded when project config is disabled via '1'", async () => {
    reset()
    const root = await temp()
    process.env.KILO_DISABLE_PROJECT_CONFIG = "1"
    const cfg = path.join(root, ".kilo", "kilo.jsonc")
    await file(cfg)

    const list = localFiles(root)

    expect(list.length).toBe(1)
    expect(list[0].file).toBe(cfg)
    expect(list[0].exists).toBe(true)
    expect(list[0].loaded).toBe(false)
    expect(list[0].recommended).toBe(true)
  })

  it("marks project file not loaded when project config is disabled via 'true'", async () => {
    reset()
    const root = await temp()
    process.env.KILO_DISABLE_PROJECT_CONFIG = "true"
    const cfg = path.join(root, ".kilo", "kilo.jsonc")
    await file(cfg)

    const list = localFiles(root)

    expect(list.length).toBe(1)
    expect(list[0].file).toBe(cfg)
    expect(list[0].exists).toBe(true)
    expect(list[0].loaded).toBe(false)
  })

  it("keeps project file loaded when KILO_DISABLE_PROJECT_CONFIG is 'false'", async () => {
    reset()
    const root = await temp()
    process.env.KILO_DISABLE_PROJECT_CONFIG = "false"
    const cfg = path.join(root, ".kilo", "kilo.jsonc")
    await file(cfg)

    const list = localFiles(root)

    expect(list.length).toBe(1)
    expect(list[0].file).toBe(cfg)
    expect(list[0].exists).toBe(true)
    expect(list[0].loaded).toBe(true)
  })

  it("keeps project file loaded when KILO_DISABLE_PROJECT_CONFIG is '0'", async () => {
    reset()
    const root = await temp()
    process.env.KILO_DISABLE_PROJECT_CONFIG = "0"
    const cfg = path.join(root, ".kilo", "kilo.jsonc")
    await file(cfg)

    const list = localFiles(root)

    expect(list.length).toBe(1)
    expect(list[0].file).toBe(cfg)
    expect(list[0].exists).toBe(true)
    expect(list[0].loaded).toBe(true)
  })

  it("keeps project file loaded when KILO_DISABLE_PROJECT_CONFIG is empty", async () => {
    reset()
    const root = await temp()
    process.env.KILO_DISABLE_PROJECT_CONFIG = ""
    const cfg = path.join(root, ".kilo", "kilo.jsonc")
    await file(cfg)

    const list = localFiles(root)

    expect(list.length).toBe(1)
    expect(list[0].file).toBe(cfg)
    expect(list[0].exists).toBe(true)
    expect(list[0].loaded).toBe(true)
  })

  it("no legacy taxonomy remains in discovered entries", async () => {
    reset()
    const root = await temp()
    const xdg = path.join(root, "xdg")
    const home = path.join(root, "home")
    const spy = spyOn(os, "homedir").mockReturnValue(home)
    try {
      process.env.HOME = home
      process.env.XDG_CONFIG_HOME = xdg
      delete process.env.KILO_CONFIG_DIR
      await file(path.join(xdg, "kilo", "kilo.jsonc"))
      const ws = path.join(root, "ws")
      await file(path.join(ws, ".kilo", "kilo.jsonc"))

      const g = globalFiles()
      const l = localFiles(ws)

      for (const item of [...g, ...l]) {
        expect(["sourceGlobal", "sourceLocal"]).toContain(item.source)
        expect(item.name).toBe("kilo.jsonc")
        expect(item.file?.endsWith("kilo.jsonc")).toBe(true)
        expect((item as unknown as Record<string, unknown>).legacy).toBeUndefined()
        expect((item as unknown as Record<string, unknown>).virtual).toBeUndefined()
      }
    } finally {
      spy.mockRestore()
    }
  })
})

describe("openConfig", () => {
  it("reports local config requests without a workspace", async () => {
    reset()

    await openConfig("local", labels)

    expect(win.showWarningMessage).toHaveBeenCalledWith("No workspace")
    expect(win.showQuickPick).not.toHaveBeenCalled()
  })

  it("opens the only editable config without showing the picker", async () => {
    reset()
    const root = await temp()
    const cfg = path.join(root, ".kilo", "kilo.jsonc")
    await file(cfg)

    await openConfig("local", labels, root)

    expect(win.showQuickPick).not.toHaveBeenCalled()
    expect(workspace.openTextDocument).toHaveBeenCalledWith(expect.objectContaining({ fsPath: cfg }))
    expect(win.showTextDocument).toHaveBeenCalledWith(
      expect.objectContaining({ uri: expect.objectContaining({ fsPath: cfg }) }),
      {
        preview: false,
      },
    )
  })

  it("creates the recommended local file when no picker needed and file missing", async () => {
    reset()
    const root = await temp()
    const cfg = path.join(root, ".kilo", "kilo.jsonc")

    await openConfig("local", labels, root)

    // single entry -> no picker
    expect(win.showQuickPick).not.toHaveBeenCalled()
    expect(await Bun.file(cfg).text()).toBe(`{
  "$schema": "https://app.kilo.ai/config.json"
}
`)
    expect(workspace.openTextDocument).toHaveBeenCalledWith(expect.objectContaining({ fsPath: cfg }))
  })

  it("creates global file via KILO_CONFIG_DIR resolved root", async () => {
    reset()
    const root = await temp()
    const extra = path.join(root, "extra")
    process.env.KILO_CONFIG_DIR = extra
    const cfg = path.join(extra, "kilo.jsonc")

    await openConfig("global", labels)

    expect(await Bun.file(cfg).text()).toBe(`{
  "$schema": "https://app.kilo.ai/config.json"
}
`)
    expect(workspace.openTextDocument).toHaveBeenCalledWith(expect.objectContaining({ fsPath: cfg }))
  })

  it("shows a localized error when opening the selected config fails", async () => {
    reset()
    const root = await temp()
    const cfg = path.join(root, ".kilo", "kilo.jsonc")
    const spy = spyOn(console, "error").mockImplementation(() => {})
    await file(cfg)
    workspace.openTextDocument = mock(async () => {
      throw new Error("disk denied")
    })

    await openConfig("local", labels, root)

    expect(win.showErrorMessage).toHaveBeenCalledWith("Open failed: disk denied")
    spy.mockRestore()
  })
})
