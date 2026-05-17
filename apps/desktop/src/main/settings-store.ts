import { homedir } from 'node:os'
import { Schema } from 'effect'
import { SettingsDataSchema, type SettingsData } from '@tao/shared/session'
import { resolveTaoStoragePaths } from '@tao/shared/storage-path'
import { readJsonFile, writeJsonFile } from './file-store'

const settingsPath = resolveTaoStoragePaths(homedir()).settings

export const defaultSettings: SettingsData = {
  version: 1,
  persistence: {
    enabled: true,
    retainDays: 30,
    maxSessionBytes: 2 * 1024 * 1024 * 1024,
    persistInput: false,
  },
}

export async function readSettings(): Promise<SettingsData | null> {
  const data = await readJsonFile<unknown>(settingsPath)
  if (data === null) return null

  const decoded = Schema.decodeUnknownOption(SettingsDataSchema)(data)
  return decoded._tag === 'Some' ? decoded.value : null
}

export async function writeSettings(data: SettingsData): Promise<void> {
  const decoded = Schema.decodeUnknownOption(SettingsDataSchema)(data)
  if (decoded._tag === 'None') throw new Error('Invalid settings data')
  await writeJsonFile(settingsPath, decoded.value)
}
