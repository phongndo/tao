import { Context, Effect } from 'effect'
import type { StateStorage } from 'zustand/middleware'

export type StorageErrorKind = 'unavailable' | 'read-failed' | 'write-failed' | 'remove-failed'

export class StorageError extends Error {
  readonly kind: StorageErrorKind

  constructor(kind: StorageErrorKind, message: string) {
    super(message)
    this.name = 'StorageError'
    this.kind = kind
  }
}

export class BrowserStorage extends Context.Service<
  BrowserStorage,
  {
    readonly getItem: (key: string) => Effect.Effect<string | null, StorageError>
    readonly setItem: (key: string, value: string) => Effect.Effect<void, StorageError>
    readonly removeItem: (key: string) => Effect.Effect<void, StorageError>
  }
>()('Tao/BrowserStorage') {}

function storageUnavailable(): StorageError {
  return new StorageError('unavailable', 'localStorage is unavailable')
}

function localStorageOrThrow(): Storage {
  if (typeof window === 'undefined' || !window.localStorage) {
    throw storageUnavailable()
  }

  return window.localStorage
}

const localStorageLive: typeof BrowserStorage.Service = {
  getItem: (key) =>
    Effect.try({
      try: () => localStorageOrThrow().getItem(key),
      catch: (error) =>
        error instanceof StorageError
          ? error
          : new StorageError('read-failed', error instanceof Error ? error.message : String(error)),
    }),
  setItem: (key, value) =>
    Effect.try({
      try: () => localStorageOrThrow().setItem(key, value),
      catch: (error) =>
        error instanceof StorageError
          ? error
          : new StorageError(
              'write-failed',
              error instanceof Error ? error.message : String(error),
            ),
    }),
  removeItem: (key) =>
    Effect.try({
      try: () => localStorageOrThrow().removeItem(key),
      catch: (error) =>
        error instanceof StorageError
          ? error
          : new StorageError(
              'remove-failed',
              error instanceof Error ? error.message : String(error),
            ),
    }),
}

function runStorage<A>(program: Effect.Effect<A, StorageError, BrowserStorage>): A {
  return Effect.runSync(Effect.provideService(program, BrowserStorage, localStorageLive))
}

function runStorageOr<A>(program: Effect.Effect<A, StorageError, BrowserStorage>, fallback: A): A {
  try {
    return runStorage(program)
  } catch (error) {
    console.warn('[storage] Operation failed, using fallback:', error)
    return fallback
  }
}

export const effectLocalStorage: StateStorage = {
  getItem: (key) =>
    runStorageOr(
      BrowserStorage.use((storage) => storage.getItem(key)),
      null,
    ),
  setItem: (key, value) =>
    runStorageOr(
      BrowserStorage.use((storage) => storage.setItem(key, value)),
      undefined,
    ),
  removeItem: (key) =>
    runStorageOr(
      BrowserStorage.use((storage) => storage.removeItem(key)),
      undefined,
    ),
}
