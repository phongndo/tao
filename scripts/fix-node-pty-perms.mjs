import { chmodSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform === 'win32') {
  process.exit(0)
}

const workspaceRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const candidates = [
  join(
    workspaceRoot,
    'apps/desktop/node_modules/node-pty/prebuilds',
    `${process.platform}-${process.arch}`,
    'spawn-helper',
  ),
  join(workspaceRoot, 'apps/desktop/node_modules/node-pty/build/Release/spawn-helper'),
  join(
    workspaceRoot,
    'node_modules/node-pty/prebuilds',
    `${process.platform}-${process.arch}`,
    'spawn-helper',
  ),
  join(workspaceRoot, 'node_modules/node-pty/build/Release/spawn-helper'),
]

for (const helperPath of candidates) {
  if (existsSync(helperPath)) {
    chmodSync(helperPath, 0o755)
  }
}
