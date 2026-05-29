import { existsSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

type TraceEvent = {
  name?: string
  cat?: string
  ph?: string
  pid?: number
  tid?: number
  ts?: number
  dur?: number
  args?: Record<string, unknown>
}

type TraceFile = {
  traceEvents?: TraceEvent[]
}

type RankedDuration = {
  name: string
  category: string
  process: string
  thread: string
  count: number
  totalMs: number
  maxMs: number
}

function readPositiveNumberEnv(name: string, fallback: number, max: number): number {
  const raw = process.env[name] ?? String(fallback)
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > max) {
    throw new Error(`${name} must be a positive number <= ${max}`)
  }
  return parsed
}

function increment(map: Map<string, number>, key: string, amount = 1): void {
  map.set(key, (map.get(key) ?? 0) + amount)
}

function rankedCounts(map: Map<string, number>, limit: number): [string, number][] {
  return [...map.entries()].sort((left, right) => right[1] - left[1]).slice(0, limit)
}

function roundMs(value: number): number {
  return Math.round(value * 100) / 100
}

function eventDurationMs(event: TraceEvent): number {
  return typeof event.dur === 'number' ? event.dur / 1000 : 0
}

function eventCategory(event: TraceEvent): string {
  return typeof event.cat === 'string' && event.cat.length > 0 ? event.cat : '(none)'
}

function eventName(event: TraceEvent): string {
  return typeof event.name === 'string' && event.name.length > 0 ? event.name : '(unnamed)'
}

function pidTidKey(event: TraceEvent): string {
  return `${event.pid ?? 'unknown'}:${event.tid ?? 'unknown'}`
}

function topDurationGroups(
  events: readonly TraceEvent[],
  processes: ReadonlyMap<number, string>,
  threads: ReadonlyMap<string, string>,
  limit: number,
): RankedDuration[] {
  const groups = new Map<string, RankedDuration>()
  for (const event of events) {
    if (typeof event.dur !== 'number' || event.dur <= 0) continue

    const process =
      typeof event.pid === 'number' ? (processes.get(event.pid) ?? String(event.pid)) : 'unknown'
    const threadKey = pidTidKey(event)
    const thread = threads.get(threadKey) ?? threadKey
    const name = eventName(event)
    const category = eventCategory(event)
    const key = `${process}\0${thread}\0${name}\0${category}`
    const durationMs = eventDurationMs(event)
    const existing = groups.get(key)
    if (existing) {
      existing.count += 1
      existing.totalMs += durationMs
      existing.maxMs = Math.max(existing.maxMs, durationMs)
    } else {
      groups.set(key, {
        name,
        category,
        process,
        thread,
        count: 1,
        totalMs: durationMs,
        maxMs: durationMs,
      })
    }
  }

  return [...groups.values()]
    .sort((left, right) => right.totalMs - left.totalMs)
    .slice(0, limit)
    .map((entry) => ({
      ...entry,
      totalMs: roundMs(entry.totalMs),
      maxMs: roundMs(entry.maxMs),
    }))
}

function main(): void {
  const tracePath = resolve(process.argv[2] ?? 'out/bench/electron-smoke-trace.json')
  const longTaskThresholdMs = readPositiveNumberEnv('TAU_TRACE_LONG_TASK_MS', 50, 60_000)

  if (!existsSync(tracePath)) {
    throw new Error(`Trace file does not exist: ${tracePath}`)
  }

  const trace = JSON.parse(readFileSync(tracePath, 'utf8')) as TraceFile
  const events = Array.isArray(trace.traceEvents) ? trace.traceEvents : []
  if (events.length === 0) {
    throw new Error(`Trace file does not contain traceEvents: ${tracePath}`)
  }

  const categories = new Map<string, number>()
  const phases = new Map<string, number>()
  const eventNames = new Map<string, number>()
  const processes = new Map<number, string>()
  const threads = new Map<string, string>()
  let minTraceTs = Number.POSITIVE_INFINITY
  let maxTs = 0

  for (const event of events) {
    const name = eventName(event)
    increment(eventNames, name)
    if (typeof event.ph === 'string') increment(phases, event.ph)
    for (const category of eventCategory(event).split(',')) increment(categories, category)

    if (
      typeof event.pid === 'number' &&
      name === 'process_name' &&
      typeof event.args?.name === 'string'
    ) {
      processes.set(event.pid, event.args.name)
    }
    if (name === 'thread_name' && typeof event.args?.name === 'string') {
      threads.set(pidTidKey(event), event.args.name)
    }
    if (typeof event.ts === 'number' && eventCategory(event) !== '__metadata') {
      minTraceTs = Math.min(minTraceTs, event.ts)
      maxTs = Math.max(maxTs, event.ts + (typeof event.dur === 'number' ? event.dur : 0))
    }
  }

  const rendererMainThreads = new Set(
    [...threads.entries()]
      .filter(([, threadName]) => threadName === 'CrRendererMain')
      .map(([key]) => key),
  )
  const browserMainThreads = new Set(
    [...threads.entries()]
      .filter(([, threadName]) => threadName === 'CrBrowserMain')
      .map(([key]) => key),
  )
  const longRendererMainTasks = events.filter(
    (event) =>
      rendererMainThreads.has(pidTidKey(event)) && eventDurationMs(event) >= longTaskThresholdMs,
  )
  const longBrowserMainTasks = events.filter(
    (event) =>
      browserMainThreads.has(pidTidKey(event)) && eventDurationMs(event) >= longTaskThresholdMs,
  )
  const tauUserTimingEvents = events.filter((event) => eventName(event).startsWith('tau:'))

  const summary = {
    tracePath,
    sizeBytes: statSync(tracePath).size,
    eventCount: events.length,
    durationMs: Number.isFinite(minTraceTs) ? roundMs((maxTs - minTraceTs) / 1000) : null,
    processCount: processes.size,
    threadCount: threads.size,
    longTaskThresholdMs,
    longRendererMainTaskCount: longRendererMainTasks.length,
    maxRendererMainTaskMs: roundMs(
      Math.max(0, ...longRendererMainTasks.map((event) => eventDurationMs(event))),
    ),
    longBrowserMainTaskCount: longBrowserMainTasks.length,
    maxBrowserMainTaskMs: roundMs(
      Math.max(0, ...longBrowserMainTasks.map((event) => eventDurationMs(event))),
    ),
    topCategories: rankedCounts(categories, 12),
    topEvents: rankedCounts(eventNames, 12),
    tauUserTimingCount: tauUserTimingEvents.length,
    tauUserTimingNames: rankedCounts(
      tauUserTimingEvents.reduce((map, event) => {
        increment(map, eventName(event))
        return map
      }, new Map<string, number>()),
      24,
    ),
    topDurationGroups: topDurationGroups(events, processes, threads, 12),
    topRendererMainLongTasks: longRendererMainTasks
      .sort((left, right) => eventDurationMs(right) - eventDurationMs(left))
      .slice(0, 8)
      .map((event) => ({
        name: eventName(event),
        category: eventCategory(event),
        durationMs: roundMs(eventDurationMs(event)),
      })),
  }

  console.log(JSON.stringify(summary, null, 2))
}

try {
  main()
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
