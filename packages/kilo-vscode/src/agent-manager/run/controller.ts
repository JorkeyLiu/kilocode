import * as fs from "node:fs"
import * as path from "node:path"
import { getShellEnvironment } from "../shell-env"
import { RunScriptManager, type RunHandle, type RunStatus } from "./manager"
import { RunScriptService } from "./service"

export interface RunTaskConfig {
  worktreeId: string // legacy field name; used as the run-slot key
  branch: string
  command: string
  args: string[]
  cwd: string
  env: Record<string, string>
}

interface TaskExit {
  exitCode?: number
}

type StartTask = (config: RunTaskConfig, done: (exit: TaskExit) => void) => Promise<RunHandle>

interface Options {
  root: () => string | undefined
  open: (path: string) => Promise<void>
  start: StartTask
  post: (status: RunStatus) => void
  error: (msg: string) => void
  log: (msg: string) => void
  refresh?: () => void
  env?: () => Promise<Record<string, string>>
}

export class RunController {
  private service: RunScriptService | undefined
  private serviceRoot: string | undefined
  private readonly manager: RunScriptManager

  constructor(private readonly opts: Options) {
    this.manager = new RunScriptManager(opts.log, opts.post)
  }

  state(): { runStatuses: RunStatus[]; runScriptConfigured: boolean; runScriptPath?: string } {
    const service = this.getService()
    const script = service?.resolveScript()
    return {
      runStatuses: this.manager.all(),
      runScriptConfigured: !!script,
      runScriptPath: script?.path,
    }
  }

  async configure(): Promise<void> {
    const service = this.getService()
    if (!service) return
    if (!service.hasScript()) await service.createDefaultScript()
    const script = service.resolveScript()
    await this.opts.open(script?.path ?? service.getScriptPath())
    this.opts.refresh?.()
  }

  async run(worktreeId: string): Promise<void> {
    const status = this.manager.status(worktreeId)
    if (status.state !== "idle") {
      this.stop(worktreeId)
      return
    }

    const root = this.opts.root()
    const service = this.getService()
    if (!root || !service) return

    const cwd = root
    if (!cwd || !path.isAbsolute(cwd)) {
      this.opts.error("Invalid working directory")
      return
    }
    try {
      if (!fs.statSync(cwd).isDirectory()) {
        this.opts.error("Working directory is not a directory")
        return
      }
    } catch {
      this.opts.error("Working directory does not exist")
      return
    }

    const script = service.resolveTask()
    if (!script) {
      await this.configure()
      return
    }

    const branch = "local"
    const env = {
      ...(await (this.opts.env ?? getShellEnvironment)()),
      WORKSPACE_PATH: cwd,
      REPO_PATH: root,
    }

    const start = () =>
      this.opts.start({ worktreeId, branch, command: script.command, args: script.args, cwd, env }, (exit) =>
        this.manager.finish(worktreeId, { exitCode: exit.exitCode }),
      )
    await this.manager.start(worktreeId, start)
  }

  stop(worktreeId: string): void {
    this.manager.stop(worktreeId)
  }

  remove(worktreeId: string): void {
    this.manager.remove(worktreeId)
  }

  dispose(): void {
    this.manager.dispose()
  }

  private getService(): RunScriptService | undefined {
    const root = this.opts.root()
    if (!root) return undefined
    if (this.service && this.serviceRoot === root) return this.service
    this.serviceRoot = root
    this.service = new RunScriptService(root)
    return this.service
  }
}
