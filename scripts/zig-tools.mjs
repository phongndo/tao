#!/usr/bin/env node
import { existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const [command = 'help', ...targets] = process.argv.slice(2)
const targetRoots = targets.length > 0 ? targets : ['apps/daemon']
const ignoredDirectories = new Set([
  '.git',
  '.zig-cache',
  'zig-cache',
  'zig-out',
  'zig-pkg',
  'node_modules',
])

function usage() {
  console.error(`Usage: node scripts/zig-tools.mjs <fmt|fmt:check|lint> [paths...]`)
}

function collectZigFiles(root) {
  const absoluteRoot = resolve(repoRoot, root)
  if (!existsSync(absoluteRoot)) return []

  const stat = statSync(absoluteRoot)
  if (stat.isFile()) {
    return isZigSource(absoluteRoot) ? [relative(repoRoot, absoluteRoot)] : []
  }

  const files = []
  const entries = readdirSync(absoluteRoot, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (ignoredDirectories.has(entry.name)) continue
      files.push(...collectZigFiles(resolve(absoluteRoot, entry.name)))
      continue
    }

    const absolutePath = resolve(absoluteRoot, entry.name)
    if (entry.isFile() && isZigSource(absolutePath)) {
      files.push(relative(repoRoot, absolutePath))
    }
  }

  return files
}

function isZigSource(path) {
  return path.endsWith('.zig') || path.endsWith('.zon')
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: repoRoot, stdio: 'inherit' })
  if (result.error) {
    console.error(result.error.message)
    process.exit(1)
  }
  if (result.status !== 0) process.exit(result.status ?? 1)
}

const files = [...new Set(targetRoots.flatMap(collectZigFiles))].sort()
if (files.length === 0) {
  console.error(`No Zig files found under: ${targetRoots.join(', ')}`)
  process.exit(1)
}

switch (command) {
  case 'fmt':
    run('zig', ['fmt', ...files])
    break
  case 'fmt:check':
    run('zig', ['fmt', '--check', ...files])
    break
  case 'lint':
    for (const file of files) run('zig', ['ast-check', file])
    break
  default:
    usage()
    process.exit(1)
}
