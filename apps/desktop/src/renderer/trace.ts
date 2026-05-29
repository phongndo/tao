const TRACE_PREFIX = 'tau:'
const MAX_TRACE_ENTRIES = 128

export type RendererTraceEntry = {
  name: string
  entryType: string
  startTime: number
  duration: number
}

type RendererTraceApi = {
  entries(): RendererTraceEntry[]
}

declare global {
  interface Window {
    __TAU_RENDERER_TRACE__?: RendererTraceApi
  }
}

function traceName(name: string): string {
  return name.startsWith(TRACE_PREFIX) ? name : `${TRACE_PREFIX}${name}`
}

export function markRendererEvent(name: string): void {
  if (typeof performance === 'undefined' || typeof performance.mark !== 'function') return
  performance.mark(traceName(name))
}

export function startRendererSpan(name: string): () => void {
  if (
    typeof performance === 'undefined' ||
    typeof performance.mark !== 'function' ||
    typeof performance.measure !== 'function'
  ) {
    return () => {}
  }

  const id = `${traceName(name)}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`
  const startName = `${id}:start`
  const endName = `${id}:end`
  performance.mark(startName)
  let finished = false

  return () => {
    if (finished) return
    finished = true
    performance.mark(endName)
    performance.measure(traceName(name), startName, endName)
  }
}

export function rendererTraceEntries(): RendererTraceEntry[] {
  if (typeof performance === 'undefined' || typeof performance.getEntries !== 'function') return []
  return performance
    .getEntries()
    .filter((entry) => entry.name.startsWith(TRACE_PREFIX))
    .slice(-MAX_TRACE_ENTRIES)
    .map((entry) => ({
      name: entry.name,
      entryType: entry.entryType,
      startTime: entry.startTime,
      duration: entry.duration,
    }))
}

if (typeof window !== 'undefined') {
  window.__TAU_RENDERER_TRACE__ = {
    entries: rendererTraceEntries,
  }
}
