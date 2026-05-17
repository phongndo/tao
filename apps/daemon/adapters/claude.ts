#!/usr/bin/env tsx
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'

interface AdapterMessage {
  command?: string
  argv?: unknown
  excerptPath?: unknown
  nativeSessionId?: unknown
}

function input(): AdapterMessage {
  return JSON.parse(process.argv[2] || '{}') as AdapterMessage
}

function write(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

function exe(argv: readonly unknown[]): string {
  return basename(String(argv[0] || ''))
}

function flagValue(argv: readonly unknown[], flags: readonly string[]): string | null {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = String(argv[index])
    for (const flag of flags) {
      if (arg === flag && index + 1 < argv.length && !String(argv[index + 1]).startsWith('-')) {
        return String(argv[index + 1])
      }
      if (arg.startsWith(`${flag}=`)) {
        const value = arg.slice(flag.length + 1)
        if (value) return value
      }
    }
  }
  return null
}

function readExcerpt(path: unknown): string {
  if (typeof path !== 'string' || path.length === 0) return ''
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

function discover(msg: AdapterMessage): string | null {
  const argv = Array.isArray(msg.argv) ? msg.argv : []
  return (
    flagValue(argv, ['--resume', '--session', '--session-id', '--conversation', '-r']) ||
    readExcerpt(msg.excerptPath).match(
      /(?:claude[-_\s]?session|conversation|session(?:\s+id)?)[^A-Za-z0-9._:-]+([A-Za-z0-9][A-Za-z0-9._:-]*)/i,
    )?.[1] ||
    null
  )
}

const msg = input()
const argv = Array.isArray(msg.argv) ? msg.argv : []
const detected = exe(argv) === 'claude'

switch (msg.command) {
  case 'detect':
    write({ detected, nativeSessionId: detected ? discover(msg) : null })
    break
  case 'discover-session':
    write({ nativeSessionId: detected ? discover(msg) : null })
    break
  case 'resume-command':
    write({
      argv:
        typeof msg.nativeSessionId === 'string'
          ? [argv[0] || 'claude', '--resume', msg.nativeSessionId]
          : null,
    })
    break
  default:
    write({ detected: false })
}
