import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import net from 'node:net'
import { fileURLToPath } from 'node:url'
import { TAOD_CONTROL_CAPABILITIES, TAOD_CONTROL_PROTOCOL_VERSION } from '@tao/shared/taod-protocol'
import {
  WorkspaceAddInputSchema,
  WorkspaceDiffPatchInputSchema,
  WorkspaceGitPathActionInputSchema,
  WorkspaceRefreshInputSchema,
  WorkspaceRemoveInputSchema,
  WorktreeCreateInputSchema,
  WorktreeRefreshInputSchema,
  WorktreeRemoveInputSchema,
} from '@tao/shared/workspace'
import { Schema } from 'effect'
import { TaodClient, type TaodControlResponse } from './taod-client'

type ControlRequest = Record<string, unknown>

const streamDiagnostics = {
  active_subscribers: 0,
  pending_output_sessions: 0,
  pending_output_frames: 0,
  pending_output_bytes: 0,
  input_frames_total: 0,
  input_bytes_total: 0,
  output_frames_total: 7,
  output_bytes_total: 1234,
  slow_subscriber_drops_total: 0,
  pending_output_dropped_frames_total: 1,
  pending_output_dropped_bytes_total: 256,
  pending_output_truncated_bytes_total: 512,
}

const controlDiagnostics = {
  request_count: 3,
  failure_count: 1,
  last_request_type: 'create',
  last_trace_id: 'trace-create',
  last_duration_ms: 4,
  last_ok: true,
  last_recorded_at_ms: 1_700_000_000_000,
}

const fixtureRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../..',
  'packages/shared/fixtures/taod-protocol',
)

function readJsonFixture(name: string): ControlRequest {
  return JSON.parse(readFileSync(resolve(fixtureRoot, name), 'utf8').trim()) as ControlRequest
}

function pingResponse(overrides: Partial<TaodControlResponse> = {}): TaodControlResponse {
  return {
    id: 'ping-test',
    ok: true,
    status: 'ok',
    protocol_version: TAOD_CONTROL_PROTOCOL_VERSION,
    daemon_version: 'test-daemon',
    capabilities: [...TAOD_CONTROL_CAPABILITIES],
    stream_diagnostics: streamDiagnostics,
    control_diagnostics: controlDiagnostics,
    ...overrides,
  }
}

async function withSocketPath<T>(run: (socketPath: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'tao-taod-client-'))
  try {
    return await run(join(dir, 'taod.sock'))
  } finally {
    rmSync(dir, { force: true, recursive: true })
  }
}

async function withControlServer<T>(
  handler: (request: ControlRequest) => TaodControlResponse | 'close',
  run: (socketPath: string) => Promise<T>,
): Promise<T> {
  return withSocketPath(async (socketPath) => {
    const server = net.createServer((socket) => {
      let pending = ''
      socket.on('data', (chunk) => {
        pending += chunk.toString('utf8')
        const newline = pending.indexOf('\n')
        if (newline === -1) return
        const line = pending.slice(0, newline)
        pending = pending.slice(newline + 1)
        const request = JSON.parse(line) as ControlRequest
        const response = handler(request)
        if (response === 'close') {
          socket.destroy()
          return
        }
        socket.end(
          `${JSON.stringify({
            ...response,
            ...(typeof request.traceId === 'string' ? { trace_id: request.traceId } : {}),
          })}\n`,
        )
      })
    })

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(socketPath, () => {
        server.off('error', reject)
        resolve()
      })
    })

    try {
      return await run(socketPath)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
}

function testClient(socketPath: string): TaodClient {
  return new TaodClient({
    socketPath,
    connectTimeoutMs: 50,
    controlResponseTimeoutMs: 100,
    startTimeoutMs: 100,
    healthCheckIntervalMs: 0,
    restartBackoffMs: 10,
    detachDaemon: false,
  })
}

test('TaodClient lifecycle diagnostics report absent socket without spawning', async () => {
  await withSocketPath(async (socketPath) => {
    const client = testClient(socketPath)
    try {
      const diagnostics = await client.refreshLifecycleDiagnostics()
      assert.equal(diagnostics.state, 'absent')
      assert.equal(diagnostics.daemonOwnership, 'none')
      assert.equal(diagnostics.recoveryAction, 'start-daemon')
      assert.match(diagnostics.lastReason ?? '', /^ping-failed:/)
      assert.equal(diagnostics.startInFlight, false)
      assert.equal(diagnostics.restartScheduled, false)
      assert.equal(diagnostics.timing.clientCreatedAt, diagnostics.transitions[0]?.at)
      assert.ok(diagnostics.timing.lastPingStartedAt)
      const pingDurationMs = diagnostics.timing.lastPingDurationMs
      if (pingDurationMs === undefined) assert.fail('missing ping duration')
      assert.ok(pingDurationMs >= 0)
      assert.ok(diagnostics.timing.lastFailedPingAt)
    } finally {
      await client.dispose()
    }
  })
})

test('TaodClient lifecycle diagnostics report compatible external daemon and stream counters', async () => {
  await withControlServer(
    (request) => {
      assert.equal(request.type, 'ping')
      return pingResponse({ id: String(request.id ?? 'ping-test') })
    },
    async (socketPath) => {
      const client = testClient(socketPath)
      try {
        const diagnostics = await client.refreshLifecycleDiagnostics()
        assert.match(diagnostics.clientTraceId, /^taod-client-/)
        assert.equal(diagnostics.state, 'external-live')
        assert.equal(diagnostics.daemonOwnership, 'external')
        assert.equal(diagnostics.recoveryAction, 'reuse-external-daemon')
        assert.equal(diagnostics.daemonVersion, 'test-daemon')
        assert.equal(diagnostics.protocolVersion, TAOD_CONTROL_PROTOCOL_VERSION)
        assert.deepEqual(diagnostics.capabilities, [...TAOD_CONTROL_CAPABILITIES])
        assert.equal(diagnostics.streamDiagnostics?.outputBytesTotal, 1234)
        assert.equal(diagnostics.streamDiagnostics?.pendingOutputDroppedFramesTotal, 1)
        assert.equal(diagnostics.streamDiagnostics?.pendingOutputDroppedBytesTotal, 256)
        assert.equal(diagnostics.streamDiagnostics?.pendingOutputTruncatedBytesTotal, 512)
        assert.equal(diagnostics.daemonControlDiagnostics?.requestCount, 3)
        assert.equal(diagnostics.daemonControlDiagnostics?.failureCount, 1)
        assert.equal(diagnostics.daemonControlDiagnostics?.lastRequestType, 'create')
        assert.equal(diagnostics.daemonControlDiagnostics?.lastTraceId, 'trace-create')
        assert.equal(diagnostics.daemonControlDiagnostics?.lastDurationMs, 4)
        assert.equal(diagnostics.daemonControlDiagnostics?.lastOk, true)
        assert.equal(diagnostics.daemonControlDiagnostics?.lastRecordedAtMs, 1_700_000_000_000)
        assert.ok(diagnostics.timing.lastSuccessfulPingAt)
        const pingDurationMs = diagnostics.timing.lastPingDurationMs
        if (pingDurationMs === undefined) assert.fail('missing ping duration')
        assert.ok(pingDurationMs >= 0)
        assert.equal(diagnostics.timing.lastTransitionAt, diagnostics.transitions.at(-1)?.at)
      } finally {
        await client.dispose()
      }
    },
  )
})

test('TaodClient lifecycle recovery reuses compatible external daemons', async () => {
  await withControlServer(
    (request) => {
      assert.equal(request.type, 'ping')
      return pingResponse({ id: String(request.id ?? 'ping-test') })
    },
    async (socketPath) => {
      const client = testClient(socketPath)
      try {
        const diagnostics = await client.refreshLifecycleDiagnostics()
        assert.equal(diagnostics.recoveryAction, 'reuse-external-daemon')

        const recovered = await client.applyLifecycleRecovery('reuse-external-daemon')
        assert.equal(recovered.state, 'external-live')
        assert.equal(recovered.daemonOwnership, 'external')
        assert.equal(recovered.recoveryAction, 'reuse-external-daemon')
      } finally {
        await client.dispose()
      }
    },
  )
})

test('TaodClient lifecycle diagnostics report protocol version mismatch', async () => {
  await withControlServer(
    (request) => pingResponse({ id: String(request.id ?? 'ping-test'), protocol_version: 999 }),
    async (socketPath) => {
      const client = testClient(socketPath)
      try {
        const diagnostics = await client.refreshLifecycleDiagnostics()
        assert.equal(diagnostics.state, 'version-mismatch')
        assert.equal(diagnostics.daemonOwnership, 'external')
        assert.equal(diagnostics.recoveryAction, 'replace-incompatible-daemon')
        assert.equal(diagnostics.lastReason, 'ping-version-mismatch')
        assert.match(diagnostics.lastError ?? '', /protocol mismatch/)
      } finally {
        await client.dispose()
      }
    },
  )
})

test('TaodClient lifecycle recovery refuses to replace external incompatible daemons', async () => {
  await withControlServer(
    (request) => pingResponse({ id: String(request.id ?? 'ping-test'), protocol_version: 999 }),
    async (socketPath) => {
      const client = testClient(socketPath)
      try {
        const diagnostics = await client.refreshLifecycleDiagnostics()
        assert.equal(diagnostics.state, 'version-mismatch')
        assert.equal(diagnostics.daemonOwnership, 'external')
        assert.equal(diagnostics.recoveryAction, 'replace-incompatible-daemon')

        await assert.rejects(
          () => client.applyLifecycleRecovery('replace-incompatible-daemon'),
          /does not own a running daemon/,
        )
      } finally {
        await client.dispose()
      }
    },
  )
})

test('TaodClient lifecycle diagnostics report stale socket on malformed daemon response', async () => {
  await withControlServer(
    () => 'close',
    async (socketPath) => {
      const client = testClient(socketPath)
      try {
        const diagnostics = await client.refreshLifecycleDiagnostics()
        assert.equal(diagnostics.state, 'stale-socket')
        assert.equal(diagnostics.daemonOwnership, 'none')
        assert.equal(diagnostics.recoveryAction, 'clear-stale-socket-and-start')
        assert.equal(diagnostics.lastReason, 'ping-failed')
      } finally {
        await client.dispose()
      }
    },
  )
})

test('TaodClient records control request timing for successful daemon calls', async () => {
  await withControlServer(
    (request) => {
      if (request.type === 'ping') return pingResponse({ id: String(request.id ?? 'ping-test') })
      if (request.type === 'create') {
        return {
          id: String(request.id ?? 'create-test'),
          ok: true,
          session_id: String(request.sessionId ?? ''),
          stream_id: 'stream-test',
          status: 'live',
          pid: 123,
        }
      }
      return { id: String(request.id ?? 'unknown'), ok: false, error_message: 'unexpected request' }
    },
    async (socketPath) => {
      const client = testClient(socketPath)
      try {
        await client.createSession({
          sessionId: 'session-1',
          terminalId: 'terminal-1',
          workspaceId: 'workspace-1',
          cols: 80,
          rows: 24,
        })

        const diagnostics = client.getLifecycleDiagnostics()
        assert.equal(diagnostics.state, 'external-live')
        assert.equal(diagnostics.daemonOwnership, 'external')
        assert.equal(diagnostics.recoveryAction, 'reuse-external-daemon')
        assert.equal(diagnostics.controlRequestCount, 2)
        assert.equal(diagnostics.controlRequestFailureCount, 0)
        assert.equal(diagnostics.lastControlRequest?.type, 'create')
        assert.equal(
          diagnostics.lastControlRequest?.traceId,
          `${diagnostics.clientTraceId}:${diagnostics.lastControlRequest?.id}`,
        )
        assert.equal(
          diagnostics.lastControlRequest?.responseTraceId,
          diagnostics.lastControlRequest?.traceId,
        )
        assert.equal(diagnostics.lastControlRequest?.ok, true)
        assert.ok(diagnostics.lastControlRequest.durationMs >= 0)
        assert.ok(diagnostics.timing.lastSuccessfulPingAt)
      } finally {
        await client.dispose()
      }
    },
  )
})

test('TaodClient preserves daemon error codes as workspace error kinds', async () => {
  await withControlServer(
    (request) => {
      if (request.type === 'ping') return pingResponse({ id: String(request.id ?? 'ping-test') })
      return {
        id: String(request.id ?? 'workspace-test'),
        ok: false,
        error_code: 'invalid-path',
        error_message: 'invalid workspace path',
      }
    },
    async (socketPath) => {
      const client = testClient(socketPath)
      try {
        await assert.rejects(
          () => client.getGitStatus('/tmp/missing'),
          (error: unknown) =>
            error instanceof Error &&
            (error as Error & { code?: string; kind?: string }).code === 'invalid-path' &&
            (error as Error & { code?: string; kind?: string }).kind === 'invalid-path',
        )
      } finally {
        await client.dispose()
      }
    },
  )
})

test('TaodClient workspace request shapes match shared protocol fixtures', async () => {
  const observed: ControlRequest[] = []
  await withControlServer(
    (request) => {
      if (request.type !== 'ping') observed.push(request)
      if (request.type === 'ping') return pingResponse({ id: String(request.id ?? 'ping-test') })
      if (request.type === 'workspace.branches') {
        return { id: String(request.id ?? 'branches'), ok: true, branches: ['main'] }
      }
      if (request.type === 'workspace.branch') {
        return { id: String(request.id ?? 'branch'), ok: true, branch: 'main' }
      }
      if (request.type === 'workspace.gitWorktrees') {
        return { id: String(request.id ?? 'worktrees'), ok: true, worktrees: [] }
      }
      if (request.type === 'workspace.status') {
        return {
          id: String(request.id ?? 'status'),
          ok: true,
          git_status: { changed: 0, staged: 0 },
        }
      }
      if (request.type === 'workspace.fileTree') {
        return {
          id: String(request.id ?? 'file-tree'),
          ok: true,
          file_tree: { paths: [], git_status: [] },
        }
      }
      if (request.type === 'workspace.diff') {
        return { id: String(request.id ?? 'diff'), ok: true, diff_patch: '' }
      }
      if (request.type === 'workspace.ports') {
        return { id: String(request.id ?? 'ports'), ok: true, ports: [] }
      }
      if (request.type === 'workspace.pullRequest') {
        return { id: String(request.id ?? 'pull-request'), ok: true, pull_request: null }
      }
      if (request.type === 'workspace.stagePath') {
        return { id: String(request.id ?? 'stage'), ok: true }
      }
      if (request.type === 'workspace.unstagePath') {
        return { id: String(request.id ?? 'unstage'), ok: true }
      }
      if (request.type === 'workspace.revertPath') {
        return { id: String(request.id ?? 'revert'), ok: true }
      }
      return {
        id: String(request.id ?? 'unexpected'),
        ok: false,
        error_code: 'invalid-response',
        error_message: 'unexpected request',
      }
    },
    async (socketPath) => {
      const client = testClient(socketPath)
      try {
        await client.listBranches('/tmp/tao-workspace')
        await client.getGitBranch('/tmp/tao-workspace')
        await client.getGitWorktrees('/tmp/tao-workspace')
        await client.getGitStatus('/tmp/tao-workspace')
        await client.getWorkspaceFileTree('/tmp/tao-workspace')
        await client.getWorkspaceDiffPatch({
          rootPath: '/tmp/tao-workspace',
          scope: 'staged',
          compareBranch: 'main',
        })
        await client.getWorkspacePorts('/tmp/tao-workspace')
        await client.getPullRequestInfo('/tmp/tao-workspace')
        await client.stagePath({
          rootPath: '/tmp/tao-workspace',
          path: ['src/app.ts', 'README.md'],
        })
        await client.unstagePath({
          rootPath: '/tmp/tao-workspace',
          path: ['src/app.ts', 'README.md'],
        })
        await client.revertPath({
          rootPath: '/tmp/tao-workspace',
          path: ['src/app.ts', 'README.md'],
        })
      } finally {
        await client.dispose()
      }
    },
  )

  assert.deepEqual(observed.map(omitDynamicRequestFields), [
    omitDynamicRequestFields(readJsonFixture('control-workspace-branches-request.ndjson')),
    omitDynamicRequestFields(readJsonFixture('control-workspace-branch-request.ndjson')),
    omitDynamicRequestFields(readJsonFixture('control-workspace-git-worktrees-request.ndjson')),
    omitDynamicRequestFields(readJsonFixture('control-workspace-status-request.ndjson')),
    omitDynamicRequestFields(readJsonFixture('control-workspace-file-tree-request.ndjson')),
    omitDynamicRequestFields(readJsonFixture('control-workspace-diff-request.ndjson')),
    omitDynamicRequestFields(readJsonFixture('control-workspace-ports-request.ndjson')),
    omitDynamicRequestFields(readJsonFixture('control-workspace-pull-request-request.ndjson')),
    omitDynamicRequestFields(readJsonFixture('control-workspace-stage-path-request.ndjson')),
    omitDynamicRequestFields(readJsonFixture('control-workspace-unstage-path-request.ndjson')),
    omitDynamicRequestFields(readJsonFixture('control-workspace-revert-path-request.ndjson')),
  ])
  assert.ok(
    observed.every(
      (request) =>
        typeof request.traceId === 'string' &&
        typeof request.id === 'string' &&
        request.traceId.endsWith(`:${request.id}`),
    ),
  )
})

test('TaodClient workspace response shapes match shared protocol fixtures', async () => {
  await withControlServer(
    (request) => {
      if (request.type === 'ping') return pingResponse({ id: String(request.id ?? 'ping-test') })
      if (request.type === 'workspace.branches') {
        return readJsonFixture('control-workspace-branches-response.ndjson') as TaodControlResponse
      }
      if (request.type === 'workspace.branch') {
        return readJsonFixture('control-workspace-branch-response.ndjson') as TaodControlResponse
      }
      if (request.type === 'workspace.gitWorktrees') {
        return readJsonFixture(
          'control-workspace-git-worktrees-response.ndjson',
        ) as TaodControlResponse
      }
      if (request.type === 'workspace.status') {
        return readJsonFixture('control-workspace-status-response.ndjson') as TaodControlResponse
      }
      if (request.type === 'workspace.fileTree') {
        return readJsonFixture('control-workspace-file-tree-response.ndjson') as TaodControlResponse
      }
      if (request.type === 'workspace.diff') {
        return readJsonFixture('control-workspace-diff-response.ndjson') as TaodControlResponse
      }
      if (request.type === 'workspace.ports') {
        return readJsonFixture('control-workspace-ports-response.ndjson') as TaodControlResponse
      }
      if (request.type === 'workspace.pullRequest') {
        return readJsonFixture(
          'control-workspace-pull-request-response.ndjson',
        ) as TaodControlResponse
      }
      if (request.type === 'workspace.stagePath') {
        return readJsonFixture(
          'control-workspace-stage-path-response.ndjson',
        ) as TaodControlResponse
      }
      if (request.type === 'workspace.unstagePath') {
        return readJsonFixture(
          'control-workspace-unstage-path-response.ndjson',
        ) as TaodControlResponse
      }
      if (request.type === 'workspace.revertPath') {
        return readJsonFixture(
          'control-workspace-revert-path-response.ndjson',
        ) as TaodControlResponse
      }
      return {
        id: String(request.id ?? 'unexpected'),
        ok: false,
        error_code: 'invalid-response',
        error_message: 'unexpected request',
      }
    },
    async (socketPath) => {
      const client = testClient(socketPath)
      try {
        assert.deepEqual(await client.listBranches('/tmp/tao-workspace'), ['main', 'origin/main'])
        assert.equal(await client.getGitBranch('/tmp/tao-workspace'), 'main')
        assert.deepEqual(await client.getGitWorktrees('/tmp/tao-workspace'), [
          {
            path: '/tmp/tao-workspace',
            branch: 'main',
            hash: 'abc123',
            isBare: false,
          },
        ])
        assert.deepEqual(await client.getGitStatus('/tmp/tao-workspace'), { changed: 2, staged: 1 })
        assert.deepEqual(await client.getWorkspaceFileTree('/tmp/tao-workspace'), {
          paths: ['README.md', 'src/app.ts'],
          gitStatus: [{ path: 'src/app.ts', status: 'modified' }],
        })
        assert.equal(
          await client.getWorkspaceDiffPatch({ rootPath: '/tmp/tao-workspace', scope: 'staged' }),
          'diff --git a/src/app.ts b/src/app.ts\n+console.log("tao")\n',
        )
        assert.deepEqual(await client.getWorkspacePorts('/tmp/tao-workspace'), [
          { port: 3000, processName: 'node' },
        ])
        assert.deepEqual(await client.getPullRequestInfo('/tmp/tao-workspace'), {
          number: 32,
          title: 'Review Tao',
          url: 'https://example.invalid/pr/32',
          state: 'OPEN',
          headRefName: 'best-operation',
        })
        await client.stagePath({ rootPath: '/tmp/tao-workspace', path: ['src/app.ts'] })
        await client.unstagePath({ rootPath: '/tmp/tao-workspace', path: ['src/app.ts'] })
        await client.revertPath({ rootPath: '/tmp/tao-workspace', path: ['src/app.ts'] })
      } finally {
        await client.dispose()
      }
    },
  )
})

test('TaodClient workspace mutation response shapes match shared protocol fixtures', async () => {
  await withControlServer(
    (request) => {
      if (request.type === 'ping') return pingResponse({ id: String(request.id ?? 'ping-test') })
      if (request.type === 'workspace.list') {
        return readJsonFixture('control-workspace-list-response.ndjson') as TaodControlResponse
      }
      if (request.type === 'workspace.add' || request.type === 'workspace.refresh') {
        return readJsonFixture('control-workspace-record-response.ndjson') as TaodControlResponse
      }
      if (request.type === 'workspace.remove') {
        return readJsonFixture('control-workspace-remove-response.ndjson') as TaodControlResponse
      }
      if (request.type === 'worktree.create' || request.type === 'worktree.refresh') {
        return readJsonFixture('control-worktree-response.ndjson') as TaodControlResponse
      }
      if (request.type === 'worktree.remove') {
        return readJsonFixture('control-worktree-remove-response.ndjson') as TaodControlResponse
      }
      return {
        id: String(request.id ?? 'unexpected'),
        ok: false,
        error_code: 'invalid-response',
        error_message: 'unexpected request',
      }
    },
    async (socketPath) => {
      const client = testClient(socketPath)
      try {
        const workspaces = await client.listWorkspaces()
        assert.equal(workspaces.length, 1)
        assert.equal(workspaces[0]?.id, 'workspace-fixture')
        assert.equal(workspaces[0]?.rootPath, '/tmp/tao-workspace')
        assert.deepEqual(workspaces[0]?.gitStatus, { changed: 1, staged: 0 })
        assert.equal(workspaces[0]?.worktrees[0]?.id, 'worktree-fixture')
        assert.deepEqual(workspaces[0]?.worktrees[0]?.gitStatus, { changed: 3, staged: 1 })

        const added = await client.addWorkspace({
          rootPath: '/tmp/tao-workspace',
          workspaceId: 'workspace-fixture',
          name: 'Tao',
          orderIndex: 1,
        })
        assert.equal(added.id, 'workspace-fixture')
        assert.equal(added.worktrees[0]?.branch, 'feature/demo')

        const refreshed = await client.refreshWorkspace('workspace-fixture')
        assert.equal(refreshed.id, 'workspace-fixture')
        await client.removeWorkspace('workspace-fixture')

        const createdWorktree = await client.createWorktree({
          workspaceId: 'workspace-fixture',
          baseBranch: 'main',
          targetBranch: 'feature/demo',
          folderName: 'feature-worktree',
        })
        assert.equal(createdWorktree.id, 'worktree-fixture')
        assert.equal(createdWorktree.workspaceId, 'workspace-fixture')
        assert.equal(createdWorktree.state, 'active')

        const refreshedWorktree = await client.refreshWorktree('worktree-fixture')
        assert.equal(refreshedWorktree.id, 'worktree-fixture')
        assert.equal(refreshedWorktree.gitStatus?.changed, 3)
        await client.removeWorktree({ worktreeId: 'worktree-fixture', force: true })
      } finally {
        await client.dispose()
      }
    },
  )
})

test('TaodClient session maintenance response shapes match shared protocol fixtures', async () => {
  await withControlServer(
    (request) => {
      if (request.type === 'ping') return pingResponse({ id: String(request.id ?? 'ping-test') })
      if (
        request.type === 'create' ||
        request.type === 'resize' ||
        request.type === 'detach' ||
        request.type === 'kill'
      ) {
        return readJsonFixture('control-session-response.ndjson') as TaodControlResponse
      }
      if (request.type === 'clear-history') {
        return readJsonFixture('control-clear-history-response.ndjson') as TaodControlResponse
      }
      if (request.type === 'cleanup') {
        return readJsonFixture('control-cleanup-response.ndjson') as TaodControlResponse
      }
      if (request.type === 'configure-persistence') {
        return readJsonFixture(
          'control-configure-persistence-response.ndjson',
        ) as TaodControlResponse
      }
      return {
        id: String(request.id ?? 'unexpected'),
        ok: false,
        error_code: 'invalid-response',
        error_message: 'unexpected request',
      }
    },
    async (socketPath) => {
      const client = testClient(socketPath)
      try {
        const create = await client.createSession({
          sessionId: 'session-fixture',
          terminalId: 'terminal-fixture',
          workspaceId: 'workspace-fixture',
          cols: 80,
          rows: 24,
          cwd: '/tmp/tao',
        })
        assert.equal(create.session_id, 'session-fixture')
        assert.equal(create.status, 'live')
        assert.equal(create.cwd, '/tmp/tao')
        assert.equal(create.cols, 80)
        assert.equal(create.rows, 24)
        assert.equal(create.last_seq, 0)
        assert.equal(create.attach_kind, 'live')

        const resize = await client.resizeSession('session-fixture', 80, 24)
        assert.equal(resize.session_id, 'session-fixture')
        assert.equal(resize.status, 'live')

        await client.detachSession('session-fixture')
        await client.killSession('session-fixture')

        const clearHistory = await client.clearHistory(['session-fixture'])
        assert.equal(clearHistory.removed_sessions, 1)
        assert.equal(clearHistory.removed_bytes, 2048)

        const cleanup = await client.cleanupSessions({
          retainDays: 30,
          maxSessionBytes: 4096,
          activeSessionIds: ['session-fixture'],
        })
        assert.equal(cleanup.removed_sessions, 2)
        assert.equal(cleanup.removed_bytes, 4096)

        const persistence = await client.configurePersistence({
          enabled: true,
          persistInput: false,
        })
        assert.equal((persistence as Record<string, unknown>).persistence_enabled, true)
        assert.equal((persistence as Record<string, unknown>).persist_input, false)
      } finally {
        await client.dispose()
      }
    },
  )
})

test('workspace IPC schemas reject malformed renderer payloads', () => {
  assert.equal(
    Schema.decodeUnknownOption(WorkspaceAddInputSchema)({
      rootPath: '',
      name: 'Tao',
    })._tag,
    'None',
  )
  assert.equal(
    Schema.decodeUnknownOption(WorkspaceAddInputSchema)({
      rootPath: '/tmp/tao-workspace',
      name: '',
    })._tag,
    'None',
  )
  assert.equal(
    Schema.decodeUnknownOption(WorkspaceAddInputSchema)({
      rootPath: '/tmp/tao-workspace',
      name: 'Tao',
      orderIndex: 'first',
    })._tag,
    'None',
  )
  assert.equal(
    Schema.decodeUnknownOption(WorkspaceAddInputSchema)({
      rootPath: '/tmp/tao-workspace',
      workspaceId: 'workspace-1',
      name: 'Tao',
      orderIndex: 1,
    })._tag,
    'Some',
  )
  assert.equal(Schema.decodeUnknownOption(WorkspaceRefreshInputSchema)('')._tag, 'None')
  assert.equal(Schema.decodeUnknownOption(WorkspaceRefreshInputSchema)('workspace-1')._tag, 'Some')
  assert.equal(Schema.decodeUnknownOption(WorkspaceRemoveInputSchema)('')._tag, 'None')
  assert.equal(Schema.decodeUnknownOption(WorkspaceRemoveInputSchema)('workspace-1')._tag, 'Some')
  assert.equal(
    Schema.decodeUnknownOption(WorktreeCreateInputSchema)({
      workspaceId: '',
      targetBranch: 'feature',
    })._tag,
    'None',
  )
  assert.equal(
    Schema.decodeUnknownOption(WorktreeCreateInputSchema)({
      workspaceId: 'workspace-1',
      targetBranch: '',
    })._tag,
    'None',
  )
  assert.equal(
    Schema.decodeUnknownOption(WorktreeCreateInputSchema)({
      workspaceId: 'workspace-1',
      targetBranch: 'feature',
      folderName: 'feature-worktree',
    })._tag,
    'Some',
  )
  assert.equal(Schema.decodeUnknownOption(WorktreeRefreshInputSchema)('')._tag, 'None')
  assert.equal(Schema.decodeUnknownOption(WorktreeRefreshInputSchema)('worktree-1')._tag, 'Some')
  assert.equal(
    Schema.decodeUnknownOption(WorktreeRemoveInputSchema)({
      worktreeId: '',
      force: true,
    })._tag,
    'None',
  )
  assert.equal(
    Schema.decodeUnknownOption(WorktreeRemoveInputSchema)({
      worktreeId: 'worktree-1',
      force: 'yes',
    })._tag,
    'None',
  )
  assert.equal(
    Schema.decodeUnknownOption(WorktreeRemoveInputSchema)({
      worktreeId: 'worktree-1',
      force: true,
      deleteBranch: false,
    })._tag,
    'Some',
  )
  assert.equal(
    Schema.decodeUnknownOption(WorkspaceDiffPatchInputSchema)({
      workspacePath: '',
      scope: 'staged',
    })._tag,
    'None',
  )
  assert.equal(
    Schema.decodeUnknownOption(WorkspaceDiffPatchInputSchema)({
      workspacePath: '/tmp/tao-workspace',
      scope: 'everything',
    })._tag,
    'None',
  )
  assert.equal(
    Schema.decodeUnknownOption(WorkspaceGitPathActionInputSchema)({
      workspacePath: '/tmp/tao-workspace',
      path: '',
    })._tag,
    'None',
  )
  assert.equal(
    Schema.decodeUnknownOption(WorkspaceGitPathActionInputSchema)({
      workspacePath: '/tmp/tao-workspace',
      path: ['src/app.ts'],
    })._tag,
    'Some',
  )
})

function omitDynamicRequestFields({
  id: _id,
  traceId: _traceId,
  ...request
}: ControlRequest): Omit<ControlRequest, 'id' | 'traceId'> {
  return request
}
