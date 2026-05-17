#!/usr/bin/env tsx
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import type { SpawnSyncOptions, SpawnSyncReturns } from 'node:child_process'

type RunOptions = {
  cwd?: string
  stdio?: SpawnSyncOptions['stdio']
  env?: NodeJS.ProcessEnv
}

type ZonDependency = {
  url: string
  hash: string
}

type NativePaths = {
  ghosttyPath: string
  uucodePath: string
  tablesPath: string
  propsPath: string
  symbolsPath: string
  ghosttyBuildOptionsPath: string
  ghosttyTerminalOptionsPath: string
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const daemonRoot = resolve(repoRoot, 'apps/daemon')
const [command = 'build', ...rawArgs] = process.argv.slice(2)
const passthroughArgs = rawArgs[0] === '--' ? rawArgs.slice(1) : rawArgs

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

function run(
  command: string,
  args: readonly string[],
  options: RunOptions = {},
): SpawnSyncReturns<Buffer> {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? daemonRoot,
    stdio: options.stdio ?? 'inherit',
    env: options.env ?? process.env,
  })
  if (result.error) fail(result.error.message)
  if (result.status !== 0) process.exit(result.status ?? 1)
  return result
}

function capture(command: string, args: readonly string[], options: RunOptions = {}): Buffer {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? daemonRoot,
    stdio: ['ignore', 'pipe', 'inherit'],
    env: options.env ?? process.env,
  })
  if (result.error) fail(result.error.message)
  if (result.status !== 0) process.exit(result.status ?? 1)
  return result.stdout
}

function output(command: string, args: readonly string[], cwd = daemonRoot): string {
  const result = spawnSync(command, args, {
    cwd,
    stdio: ['ignore', 'pipe', 'inherit'],
    encoding: 'utf8',
  })
  if (result.error) fail(result.error.message)
  if (result.status !== 0) process.exit(result.status ?? 1)
  return result.stdout.trim()
}

function assertZigVersion(): string {
  const version = output('zig', ['version'])
  if (!version.startsWith('0.15.')) {
    fail(`taod requires Zig 0.15.x; found ${version}. Run: nix profile install nixpkgs#zig_0_15`)
  }
  return version
}

function zonDependency(zonPath: string, name: string): ZonDependency {
  const zon = readFileSync(zonPath, 'utf8')
  const pattern = new RegExp(
    `\\.${name}\\s*=\\s*\\.\\{[\\s\\S]*?\\.url\\s*=\\s*"([^"]+)"[\\s\\S]*?\\.hash\\s*=\\s*"([^"]+)"`,
    'u',
  )
  const match = zon.match(pattern)
  if (!match) fail(`Could not find .${name} dependency in ${zonPath}`)
  return { url: match[1], hash: match[2] }
}

function ensurePackage(dep: ZonDependency): string {
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

function writeFileIfChanged(path: string, contents: string): void {
  if (existsSync(path) && readFileSync(path, 'utf8') === contents) return
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, contents)
}

function tryParseJson(value: string): { global_cache_dir?: string } | null {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function darwinTarget(): string {
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64'
  return `${arch}-macos.15.0`
}

function darwinBuildOptionsPath(): string {
  const cacheDir = resolve(daemonRoot, '.zig-cache')
  mkdirSync(cacheDir, { recursive: true })
  const path = resolve(cacheDir, 'taod-build-options.zig')
  writeFileIfChanged(path, 'pub const vt_backend = "ghostty_native";\n')
  return path
}

function ghosttyBuildOptionsPath(dir: string): string {
  const path = resolve(dir, 'ghostty-build-options.zig')
  writeFileIfChanged(path, 'pub const simd = false;\n')
  return path
}

function ghosttyTerminalOptionsPath(dir: string): string {
  const path = resolve(dir, 'ghostty-terminal-options.zig')
  writeFileIfChanged(
    path,
    `pub const Artifact = enum { ghostty, lib };
pub const artifact: Artifact = .lib;
pub const c_abi = false;
pub const oniguruma = false;
pub const simd = false;
pub const slow_runtime_safety = true;
pub const kitty_graphics = false;
pub const tmux_control_mode = false;
`,
  )
  return path
}

function targetArgs(): string[] {
  if (process.platform !== 'darwin') return []
  return ['-target', darwinTarget()]
}

function uucodeBuildTablesArgs({
  ghosttyPath,
  outputPath,
}: {
  ghosttyPath: string
  outputPath: string
}): string[] {
  return [
    'run',
    ...targetArgs(),
    '-lc',
    '--dep',
    'config.zig',
    '--dep',
    'types.zig',
    '--dep',
    'build_config',
    '-Mroot=src/build/tables.zig',
    '--dep',
    'types.zig',
    '-Mconfig.zig=src/config.zig',
    '--dep',
    'config.zig',
    '-Mtypes.zig=src/types.zig',
    '--dep',
    'types.x.zig',
    '--dep',
    'types.zig',
    '--dep',
    'config.zig',
    '-Mconfig.x.zig=src/x/config.x.zig',
    '--dep',
    'config.x.zig',
    '-Mtypes.x.zig=src/x/types.x.zig',
    '--dep',
    'config.zig',
    '--dep',
    'config.x.zig',
    '--dep',
    'types.zig',
    '--dep',
    'types.x.zig',
    `-Mbuild_config=${resolve(ghosttyPath, 'src/build/uucode_config.zig')}`,
    '--',
    outputPath,
  ]
}

function uucodeModuleArgs({ uucodePath, ghosttyPath, tablesPath }: NativePaths): string[] {
  const ghosttyUucodeConfig = resolve(ghosttyPath, 'src/build/uucode_config.zig')
  return [
    '--dep',
    'types.zig',
    '--dep',
    'config.zig',
    '--dep',
    'types.x.zig',
    '--dep',
    'tables',
    '--dep',
    'get.zig',
    `-Muucode=${resolve(uucodePath, 'src/root.zig')}`,
    '--dep',
    'types.zig',
    `-Mconfig.zig=${resolve(uucodePath, 'src/config.zig')}`,
    '--dep',
    'config.zig',
    '--dep',
    'get.zig',
    `-Mtypes.zig=${resolve(uucodePath, 'src/types.zig')}`,
    '--dep',
    'types.x.zig',
    '--dep',
    'types.zig',
    '--dep',
    'config.zig',
    `-Mconfig.x.zig=${resolve(uucodePath, 'src/x/config.x.zig')}`,
    '--dep',
    'config.x.zig',
    `-Mtypes.x.zig=${resolve(uucodePath, 'src/x/types.x.zig')}`,
    '--dep',
    'types.zig',
    '--dep',
    'types.x.zig',
    '--dep',
    'config.zig',
    '--dep',
    'build_config',
    `-Mtables=${tablesPath}`,
    '--dep',
    'types.zig',
    '--dep',
    'tables',
    `-Mget.zig=${resolve(uucodePath, 'src/get.zig')}`,
    '--dep',
    'config.zig',
    '--dep',
    'config.x.zig',
    '--dep',
    'types.zig',
    '--dep',
    'types.x.zig',
    `-Mbuild_config=${ghosttyUucodeConfig}`,
  ]
}

function ghosttyUnicodeGeneratorArgs(kind: 'props' | 'symbols', native: NativePaths): string[] {
  return [
    'run',
    ...targetArgs(),
    '-lc',
    '--dep',
    'uucode',
    `-Mroot=src/unicode/${kind}_uucode.zig`,
    ...uucodeModuleArgs(native),
  ]
}

function ensureGhosttyNativeDirect(): NativePaths {
  const ghosttyDep = zonDependency(resolve(daemonRoot, 'build.zig.zon'), 'ghostty')
  const ghosttyPath = ensurePackage(ghosttyDep)
  const uucodeDep = zonDependency(resolve(ghosttyPath, 'build.zig.zon'), 'uucode')
  const uucodePath = ensurePackage(uucodeDep)

  const generatedDir = resolve(daemonRoot, '.zig-cache', `ghostty-vt-${ghosttyDep.hash}`)
  mkdirSync(generatedDir, { recursive: true })

  const native = {
    ghosttyPath,
    uucodePath,
    tablesPath: resolve(generatedDir, 'uucode-tables.zig'),
    propsPath: resolve(generatedDir, 'props.zig'),
    symbolsPath: resolve(generatedDir, 'symbols.zig'),
    ghosttyBuildOptionsPath: ghosttyBuildOptionsPath(generatedDir),
    ghosttyTerminalOptionsPath: ghosttyTerminalOptionsPath(generatedDir),
  }

  if (!existsSync(native.tablesPath)) {
    run('zig', uucodeBuildTablesArgs({ ghosttyPath, outputPath: native.tablesPath }), {
      cwd: uucodePath,
    })
  }
  if (!existsSync(native.propsPath)) {
    writeFileSync(
      native.propsPath,
      capture('zig', ghosttyUnicodeGeneratorArgs('props', native), { cwd: ghosttyPath }),
    )
  }
  if (!existsSync(native.symbolsPath)) {
    writeFileSync(
      native.symbolsPath,
      capture('zig', ghosttyUnicodeGeneratorArgs('symbols', native), { cwd: ghosttyPath }),
    )
  }

  return native
}

function ghosttyModuleArgs(native: NativePaths): string[] {
  return [
    '--dep',
    'uucode',
    '--dep',
    'unicode_tables',
    '--dep',
    'symbols_tables',
    '--dep',
    'terminal_options',
    '--dep',
    'build_options=ghostty_build_options',
    `-Mghostty-vt=${resolve(native.ghosttyPath, 'src/lib_vt.zig')}`,
    ...uucodeModuleArgs(native),
    `-Municode_tables=${native.propsPath}`,
    `-Msymbols_tables=${native.symbolsPath}`,
    `-Mterminal_options=${native.ghosttyTerminalOptionsPath}`,
    `-Mghostty_build_options=${native.ghosttyBuildOptionsPath}`,
  ]
}

function directCompileArgs({
  root,
  binPath,
}: {
  root: 'main' | 'root'
  binPath?: string
}): string[] {
  const zigSqlite = zonDependency(resolve(daemonRoot, 'build.zig.zon'), 'sqlite')
  const zigSqlitePath = ensurePackage(zigSqlite)
  const sqliteAmalgamation = zonDependency(resolve(zigSqlitePath, 'build.zig.zon'), 'sqlite')
  const sqliteAmalgamationPath = ensurePackage(sqliteAmalgamation)
  const buildOptionsPath = darwinBuildOptionsPath()
  const ghosttyNative = ensureGhosttyNativeDirect()

  const args = [
    root === 'main' ? 'build-exe' : 'test',
    ...targetArgs(),
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
      'build_options=taod_build_options',
      '--dep',
      'ghostty-vt',
      '-Mtaod=src/root.zig',
    )
  } else {
    args.push(
      '--dep',
      'sqlite',
      '--dep',
      'build_options=taod_build_options',
      '--dep',
      'ghostty-vt',
      '-Mroot=src/root.zig',
    )
  }

  args.push(
    '-I',
    resolve(zigSqlitePath, 'c'),
    '-I',
    sqliteAmalgamationPath,
    `-Msqlite=${resolve(zigSqlitePath, 'sqlite.zig')}`,
    `-Mtaod_build_options=${buildOptionsPath}`,
    ...ghosttyModuleArgs(ghosttyNative),
    '-lc',
  )
  if (process.platform === 'linux') args.push('-lutil')

  return args
}

function buildDirect(): string {
  const binDir = resolve(daemonRoot, 'zig-out/bin')
  mkdirSync(binDir, { recursive: true })
  const exeName = process.platform === 'win32' ? 'taod.exe' : 'taod'
  const binPath = resolve(binDir, exeName)
  run('zig', directCompileArgs({ root: 'main', binPath }))
  return binPath
}

function withTemporaryHome<T>(callback: (home: string) => T): T {
  const home = mkdtempSync(resolve(tmpdir(), 'taod-home-'))
  try {
    return callback(home)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

function leakCheckEnv(home: string): NodeJS.ProcessEnv {
  return { ...process.env, HOME: home, TAOD_DEBUG_ALLOC: '1' }
}

function testAndBuildDirect(): void {
  const cacheDir = resolve(daemonRoot, '.zig-cache')
  mkdirSync(cacheDir, { recursive: true })
  run('zig', directCompileArgs({ root: 'root', binPath: resolve(cacheDir, 'taod-root-test') }))
  run('zig', directCompileArgs({ root: 'main', binPath: resolve(cacheDir, 'taod-main-test') }))
}

assertZigVersion()

if (process.env.TAOD_SKIP_NATIVE === '1') {
  switch (command) {
    case 'build':
    case 'test':
    case 'check':
    case 'leak-check':
      console.warn(`Skipping taod ${command}; TAOD_SKIP_NATIVE=1`)
      process.exit(0)
    case 'run':
      fail('Cannot run taod when TAOD_SKIP_NATIVE=1')
    default:
      fail(`Unknown taod zig command: ${command}`)
  }
}

if (process.platform === 'win32') {
  switch (command) {
    case 'build':
    case 'test':
    case 'check':
    case 'leak-check':
      console.warn(`Skipping taod ${command} on Windows; taod is POSIX-only`)
      process.exit(0)
    case 'run':
      fail('Cannot run taod on Windows; taod is POSIX-only')
    default:
      fail(`Unknown taod zig command: ${command}`)
  }
}

if (process.platform !== 'darwin' || process.env.TAOD_USE_ZIG_BUILD === '1') {
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
    case 'leak-check':
      withTemporaryHome((home) => {
        run('zig', ['build', 'run', '--', '--check'], { env: leakCheckEnv(home) })
      })
      break
    default:
      fail(`Unknown taod zig command: ${command}`)
  }
  process.exit(0)
}

switch (command) {
  case 'build':
    buildDirect()
    break
  case 'test':
    testAndBuildDirect()
    break
  case 'run': {
    const binaryPath = buildDirect()
    run(binaryPath, passthroughArgs, { cwd: daemonRoot })
    break
  }
  case 'check': {
    const binaryPath = buildDirect()
    run(binaryPath, ['--check'], { cwd: daemonRoot })
    break
  }
  case 'leak-check': {
    const binaryPath = buildDirect()
    withTemporaryHome((home) => {
      run(binaryPath, ['--check'], { cwd: daemonRoot, env: leakCheckEnv(home) })
    })
    break
  }
  default:
    fail(`Unknown taod zig command: ${command}`)
}
