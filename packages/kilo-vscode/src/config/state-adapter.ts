/**
 * P4.1 Adapter factories — state, watcher, and secret persistence bridges.
 *
 * State: Wraps VS Code globalState/workspaceState into StateAdapter.
 * Watcher: Wraps VS Code createFileSystemWatcher into WatcherAdapter.
 * Secret: (in secret-adapter.ts) Wraps VS Code SecretStorage.
 *
 * Memory adapters for testing with the same API contract.
 *
 * Key registry:
 * - globalState: `kilo.canonicalIndex.providers`, `kilo.canonicalIndex.globalModel`
 * - workspaceState: `kilo.canonicalIndex.agents`, `kilo.canonicalIndex.projectModel`
 */

import * as vscode from "vscode"
import type { ExtensionContext, Memento } from "vscode"
import type { StateAdapter, WatcherAdapter, TypedEmitter, EmitterFactory } from "./types"

// ── State adapters ──────────────────────────────────────────────────

/**
 * Create a StateAdapter backed by a VS Code Memento (globalState or workspaceState).
 */
export function createVscodeStateAdapter(memento: Memento): StateAdapter {
  return {
    get: <T>(key: string): T | undefined => {
      return memento.get<T>(key)
    },
    update: async (key: string, value: unknown): Promise<void> => {
      await memento.update(key, value)
    },
  }
}

/**
 * Create an in-memory StateAdapter for testing.
 */
export function createMemoryStateAdapter(): StateAdapter & { readonly data_: Map<string, unknown> } {
  const data_ = new Map<string, unknown>()
  return {
    data_,
    get: <T>(key: string): T | undefined => {
      return data_.get(key) as T | undefined
    },
    update: async (key: string, value: unknown): Promise<void> => {
      data_.set(key, value)
    },
  }
}

// ── Watcher adapters ────────────────────────────────────────────────

/**
 * Create a WatcherAdapter backed by VS Code createFileSystemWatcher.
 * Correction 10: passes the changed URI path for exact own-write coalescing.
 */
export function createVscodeWatcherAdapter(): WatcherAdapter {
  return {
    watch(dir: string, pattern: string, onChange, onCreate, onDelete) {
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(dir, pattern),
      )
      watcher.onDidChange((uri) => onChange(uri.fsPath))
      watcher.onDidCreate((uri) => onCreate(uri.fsPath))
      watcher.onDidDelete((uri) => onDelete(uri.fsPath))
      return watcher
    },
  }
}

/**
 * Create an in-memory WatcherAdapter for testing.
 * Exposes registered watchers so tests can simulate file system events.
 */
export function createMemoryWatcherAdapter(): WatcherAdapter & { readonly watchers_: MemoryWatcher[] } {
  const watchers_: MemoryWatcher[] = []
  return {
    watchers_,
    watch(dir, pattern, onChange, onCreate, onDelete) {
      const w: MemoryWatcher = { dir, pattern, onChange, onCreate, onDelete, disposed: false }
      watchers_.push(w)
      return {
        dispose() { w.disposed = true },
      }
    },
  }
}

export interface MemoryWatcher {
  dir: string
  pattern: string
  onChange: (changedPath?: string) => void
  onCreate: (createdPath?: string) => void
  onDelete: (deletedPath?: string) => void
  disposed: boolean
}

// ── Emitter adapters ────────────────────────────────────────────────

/**
 * Create an EmitterFactory that produces in-memory event emitters for testing.
 */
export function createMemoryEmitterFactory(): EmitterFactory & { readonly emitters_: MemoryEmitter<any>[] } {
  const emitters_: MemoryEmitter<any>[] = []
  return {
    emitters_,
    create: <T>() => {
      const listeners: Array<(e: T) => void> = []
      const emitter: MemoryEmitter<T> = { listeners, fired: [] }
      emitters_.push(emitter)
      return {
        event: (listener: (e: T) => void) => {
          listeners.push(listener)
          return { dispose() { const idx = listeners.indexOf(listener); if (idx >= 0) listeners.splice(idx, 1) } }
        },
        fire: (e: T) => {
          emitter.fired.push(e)
          for (const l of listeners) l(e)
        },
        dispose: () => { listeners.length = 0 },
      }
    },
  }
}

export interface MemoryEmitter<T> {
  listeners: Array<(e: T) => void>
  fired: T[]
}
