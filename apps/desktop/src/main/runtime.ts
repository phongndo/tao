import { Effect } from 'effect'

export function runMainEffect<A, E>(program: Effect.Effect<A, E, never>): Promise<A> {
  return Effect.runPromise(program)
}

export function disposeMainRuntime(): Promise<void> {
  return Promise.resolve()
}
