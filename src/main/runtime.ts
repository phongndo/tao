import { Effect, ManagedRuntime } from 'effect'
import { WorkspaceService, WorkspaceServiceLive } from './workspace-service'

const mainRuntime = ManagedRuntime.make(WorkspaceServiceLive)

export function runMainEffect<A, E>(program: Effect.Effect<A, E, WorkspaceService>): Promise<A> {
  return mainRuntime.runPromise(program)
}

export function disposeMainRuntime(): Promise<void> {
  return mainRuntime.dispose()
}
