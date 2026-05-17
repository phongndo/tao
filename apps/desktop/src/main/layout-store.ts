import { homedir } from 'node:os'
import { Schema } from 'effect'
import { PaneLayoutDataSchema, type PaneLayoutData } from '@tao/shared/session'
import { resolveTaoStoragePaths } from '@tao/shared/storage-path'
import { readJsonFile, writeJsonFile } from './file-store'

const layoutPath = resolveTaoStoragePaths(homedir()).paneLayouts

export async function readLayout(): Promise<PaneLayoutData | null> {
  const data = await readJsonFile<unknown>(layoutPath)
  if (data === null) return null

  const decoded = Schema.decodeUnknownOption(PaneLayoutDataSchema)(data)
  return decoded._tag === 'Some' ? decoded.value : null
}

export async function writeLayout(data: PaneLayoutData): Promise<void> {
  const decoded = Schema.decodeUnknownOption(PaneLayoutDataSchema)(data)
  if (decoded._tag === 'None') throw new Error('Invalid pane layout data')
  await writeJsonFile(layoutPath, decoded.value)
}
