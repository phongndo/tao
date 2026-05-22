import { parseDiffFiles, type ParsedDiffResult } from './diff-parser'
import type { DiffParseWorkerRequest, DiffParseWorkerResponse } from './diff-parser.worker'

let nextRequestId = 0
let worker: Worker | null = null
const pending = new Map<
  number,
  {
    resolve: (result: ParsedDiffResult) => void
    reject: (error: Error) => void
  }
>()

function disposeWorker(error: Error): void {
  worker?.terminate()
  worker = null
  for (const request of pending.values()) request.reject(error)
  pending.clear()
}

function ensureWorker(): Worker {
  if (worker) return worker

  worker = new Worker(new URL('./diff-parser.worker.ts', import.meta.url), { type: 'module' })
  worker.onmessage = (event: MessageEvent<DiffParseWorkerResponse>) => {
    const request = pending.get(event.data.id)
    if (!request) return
    pending.delete(event.data.id)
    request.resolve(event.data.result)
  }
  worker.onerror = (event) => {
    disposeWorker(new Error(event.message || 'diff parser worker failed'))
  }
  worker.onmessageerror = () => {
    disposeWorker(new Error('diff parser worker sent an unreadable response'))
  }
  return worker
}

export function parseDiffFilesOffThread(
  patch: string,
  idPrefix: string,
): Promise<ParsedDiffResult> {
  if (patch.trim().length === 0) return Promise.resolve({ files: [], error: null })

  return new Promise((resolve, reject) => {
    const id = ++nextRequestId
    try {
      pending.set(id, { resolve, reject })
      ensureWorker().postMessage({ id, patch, idPrefix } satisfies DiffParseWorkerRequest)
    } catch {
      pending.delete(id)
      resolve(parseDiffFiles(patch, idPrefix))
    }
  })
}
