import assert from 'node:assert/strict'
import test from 'node:test'
import {
  parsePsOutput,
  processTitleFromShell,
  resolveProcessTitle,
} from '../src/main/process-title'

test('process title falls back to the configured shell for blank terminals', () => {
  assert.equal(resolveProcessTitle(parsePsOutput('123 1 Ss /bin/zsh\n'), 123, 'zsh'), 'zsh')
  assert.equal(processTitleFromShell('/bin/zsh'), 'zsh')
})

test('process title prefers the command running under the shell', () => {
  const rows = parsePsOutput(`
    100 1 Ss /bin/zsh
    200 100 S+ /opt/homebrew/bin/codex
    201 200 S+ /opt/homebrew/Cellar/node/25.0.0/bin/node
  `)

  assert.equal(resolveProcessTitle(rows, 100, 'zsh'), 'codex')
})

test('process title strips command arguments before naming the process', () => {
  const rows = parsePsOutput(`
    100 1 Ss /bin/zsh
    200 100 S+ /usr/bin/google-chrome-stable --type=renderer
  `)

  assert.equal(resolveProcessTitle(rows, 100, 'zsh'), 'google-chrome-stable')
})

test('process title skips nested shells when a command is running inside them', () => {
  const rows = parsePsOutput(`
    100 1 Ss /bin/zsh
    200 100 S+ /bin/zsh
    201 200 S+ /usr/bin/python3
  `)

  assert.equal(resolveProcessTitle(rows, 100, 'zsh'), 'python3')
})

test('process title ignores zombie child processes', () => {
  const rows = parsePsOutput(`
    100 1 Ss /bin/zsh
    300 100 Z+ /usr/bin/vim
    200 100 S+ /usr/bin/top
  `)

  assert.equal(resolveProcessTitle(rows, 100, 'zsh'), 'top')
})
