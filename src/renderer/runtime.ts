import { Effect, Layer, ManagedRuntime } from 'effect'
import {
  WorkspaceIpcClient,
  WorkspaceIpcClientLive,
  WorkspaceMetadataCache,
  WorkspaceMetadataCacheLive,
} from './workspace-service'

type RendererServices = WorkspaceIpcClient | WorkspaceMetadataCache

const rendererLayer = Layer.mergeAll(WorkspaceIpcClientLive, WorkspaceMetadataCacheLive)
const rendererRuntime = ManagedRuntime.make(rendererLayer)

export function runRendererEffect<A, E>(
  program: Effect.Effect<A, E, RendererServices>,
): Promise<A> {
  return rendererRuntime.runPromise(program)
}

export function runRendererEffectSync<A, E>(program: Effect.Effect<A, E, RendererServices>): A {
  return rendererRuntime.runSync(program)
}
