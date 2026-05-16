#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const daemonRoot = resolve(repoRoot, 'apps/daemon')
const [command = 'build', ...rawArgs] = process.argv.slice(2)
const passthroughArgs = rawArgs[0] === '--' ? rawArgs.slice(1) : rawArgs

function fail(message) {
  console.error(message)
  process.exit(1)
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? daemonRoot,
    stdio: options.stdio ?? 'inherit',
    encoding: options.encoding,
  })
  if (result.error) fail(result.error.message)
  if (result.status !== 0) process.exit(result.status ?? 1)
  return result
}

function output(command, args, cwd = daemonRoot) {
  return run(command, args, { cwd, stdio: 'pipe', encoding: 'utf8' }).stdout.trim()
}

function assertZigVersion() {
  const version = output('zig', ['version'])
  if (!version.startsWith('0.15.')) {
    fail(`taod requires Zig 0.15.x; found ${version}. Run: nix profile install nixpkgs#zig_0_15`)
  }
  return version
}

function zonDependency(zonPath, name) {
  const zon = readFileSync(zonPath, 'utf8')
  const pattern = new RegExp(
    `\\.${name}\\s*=\\s*\\.\\{[\\s\\S]*?\\.url\\s*=\\s*"([^"]+)"[\\s\\S]*?\\.hash\\s*=\\s*"([^"]+)"`,
    'u',
  )
  const match = zon.match(pattern)
  if (!match) fail(`Could not find .${name} dependency in ${zonPath}`)
  return { url: match[1], hash: match[2] }
}

function ensurePackage(dep) {
  const envOutput = output('zig', ['env'])
  const globalCacheDir =
    tryParseJson(envOutput)?.global_cache_dir ??
    envOutput.match(/\.global_cache_dir\s*=\s*"([^"]+)"/)?.[1]
  if (!globalCacheDir) fail('Could not determine Zig global cache dir from `zig env`')
  const packagePath = resolve(globalCacheDir, 'p', dep.hash)
  if (!existsSync(packagePath)) run('zig', ['fetch', dep.url])
  if (!existsSync(packagePath)) fail(`Expected Zig package at ${packagePath}`)
  return packagePath
}

function tryParseJson(value) {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function darwinTarget() {
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64'
  return `${arch}-macos.15.0`
}

function darwinBuildOptionsPath() {
  const cacheDir = resolve(daemonRoot, '.zig-cache')
  mkdirSync(cacheDir, { recursive: true })
  const path = resolve(cacheDir, 'taod-build-options.zig')
  writeFileSync(path, 'pub const vt_backend = "fallback";\npub const libghostty_vt_c = false;\n')
  return path
}

function darwinCompileArgs({ root, binPath }) {
  const zigSqlite = zonDependency(resolve(daemonRoot, 'build.zig.zon'), 'sqlite')
  const zigSqlitePath = ensurePackage(zigSqlite)
  const sqliteAmalgamation = zonDependency(resolve(zigSqlitePath, 'build.zig.zon'), 'sqlite')
  const sqliteAmalgamationPath = ensurePackage(sqliteAmalgamation)
  const buildOptionsPath = darwinBuildOptionsPath()

  const args = [
    root === 'main' ? 'build-exe' : 'test',
    '-target',
    darwinTarget(),
    '-I',
    resolve(zigSqlitePath, 'c'),
    '-I',
    sqliteAmalgamationPath,
    '-D',
    'SQLITE_ENABLE_FTS5',
    '-D',
    'SQLITE_THREADSAFE=1',
    resolve(sqliteAmalgamationPath, 'sqlite3.c'),
    resolve(zigSqlitePath, 'c/workaround.c'),
  ]

  if (binPath) args.push(`-femit-bin=${binPath}`)

  if (root === 'main') {
    args.push(
      '--dep',
      'taod',
      '-Mroot=src/main.zig',
      '--dep',
      'sqlite',
      '--dep',
      'build_options',
      '-Mtaod=src/root.zig',
    )
  } else {
    args.push('--dep', 'sqlite', '--dep', 'build_options', '-Mroot=src/root.zig')
  }

  args.push(
    '-I',
    resolve(zigSqlitePath, 'c'),
    '-I',
    sqliteAmalgamationPath,
    `-Msqlite=${resolve(zigSqlitePath, 'sqlite.zig')}`,
    `-Mbuild_options=${buildOptionsPath}`,
    '-lc',
  )

  return args
}

function buildDarwin() {
  const binDir = resolve(daemonRoot, 'zig-out/bin')
  mkdirSync(binDir, { recursive: true })
  const exeName = process.platform === 'win32' ? 'taod.exe' : 'taod'
  const binPath = resolve(binDir, exeName)
  run('zig', darwinCompileArgs({ root: 'main', binPath }))
  return binPath
}

function testDarwin() {
  const cacheDir = resolve(daemonRoot, '.zig-cache')
  mkdirSync(cacheDir, { recursive: true })
  run('zig', darwinCompileArgs({ root: 'root', binPath: resolve(cacheDir, 'taod-root-test') }))
  run('zig', darwinCompileArgs({ root: 'main', binPath: resolve(cacheDir, 'taod-main-test') }))
}

assertZigVersion()

if (process.platform !== 'darwin') {
  switch (command) {
    case 'build':
      run('zig', ['build'])
      break
    case 'test':
      run('zig', ['build', 'test'])
      break
    case 'run':
      run('zig', ['build', 'run', '--', ...passthroughArgs])
      break
    case 'check':
      run('zig', ['build', 'run', '--', '--check'])
      break
    default:
      fail(`Unknown taod zig command: ${command}`)
  }
  process.exit(0)
}

switch (command) {
  case 'build':
    buildDarwin()
    break
  case 'test':
    testDarwin()
    break
  case 'run': {
    const binaryPath = buildDarwin()
    run(binaryPath, passthroughArgs, { cwd: daemonRoot })
    break
  }
  case 'check': {
    const binaryPath = buildDarwin()
    run(binaryPath, ['--check'], { cwd: daemonRoot })
    break
  }
  default:
    fail(`Unknown taod zig command: ${command}`)
}
