# Effect loose ends

Small follow-ups that do not fit neatly into the main facade, route, tool, or schema migration checklists.

## Config / TUI

- [ ] `cli/cmd/tui/config/tui.ts` - finish the internal Effect migration.
      Keep the current precedence and migration semantics intact while converting the remaining internal async helpers (`loadState`, `mergeFile`, `loadFile`, `load`) to `Effect.gen(...)` / `Effect.fn(...)`.
- [ ] `cli/cmd/tui/config/tui.ts` callers - once the internal service is stable, migrate plain async callers to use `TuiConfig.Service` directly where that actually simplifies the code.
      Likely first callers: `cli/cmd/tui/attach.ts`, `cli/cmd/tui/thread.ts`, `cli/cmd/tui/plugin/runtime.ts`.
- [x] `env/index.ts` - already uses `InstanceState.make(...)`.

## ConfigPaths

- [ ] `config/paths.ts` - split pure helpers from effectful helpers.
      Keep `fileInDirectory(...)` as a plain function.
- [ ] `config/paths.ts` - add a `ConfigPaths.Service` for the effectful operations so callers do not inherit `FSUtil.Service` directly.
      Initial service surface should cover:
  - `projectFiles(...)`
  - `directories(...)`
  - `readFile(...)`
  - `parseText(...)`
- [ ] `config/config.ts` - switch internal config loading from `Effect.promise(() => ConfigPaths.*(...))` to `yield* paths.*(...)` once the service exists.
- [ ] `cli/cmd/tui/config/tui.ts` - switch TUI config loading from async `ConfigPaths.*` wrappers to the `ConfigPaths.Service` once that service exists.
- [x] `cli/cmd/tui/config/tui-migrate.ts` - deleted 2026-08-27 (P4.4 residual package: `migrateTuiConfig`/`normalizeTui`/`TUI_SCHEMA_URL` with zero active callers since T27; canonical TUI loader `resolveWorktree`/`canonicalRoot` + `ConfigPaths.fileInDirectory(root, "tui")` + `path.join(root, ".kilo")` global→direct→`.kilo` preserved). No effectification needed — historical decision point preserved where appropriate.

## Notes

- Prefer small, semantics-preserving config migrations. Config precedence, legacy key migration, and plugin origin tracking are easy to break accidentally.
- When changing config loading internals, rerun the config and TUI suites first before broad package sweeps.
