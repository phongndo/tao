import { parseDiffFiles, type ParsedDiffResult } from './diff-parser'

export type DiffParseWorkerRequest = {
  id: number
  patch: string
  idPrefix: string
}

export type DiffParseWorkerResponse = {
  id: number
  result: ParsedDiffResult
}

self.onmessage = (event: MessageEvent<DiffParseWorkerRequest>) => {
  const { id, patch, idPrefix } = event.data
  const response: DiffParseWorkerResponse = {
    id,
    result: parseDiffFiles(patch, idPrefix),
  }
  self.postMessage(response)
}
