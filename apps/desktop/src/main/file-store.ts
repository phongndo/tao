import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export async function readJsonFile<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return null
    }
    throw error
  }
}

export async function writeJsonFile(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmpPath, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 })
  try {
    await rename(tmpPath, path)
  } catch (renameError) {
    try {
      await unlink(tmpPath)
    } catch (unlinkError) {
      if (!isNodeError(unlinkError) || unlinkError.code !== 'ENOENT') throw unlinkError
    }
    throw renameError
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error
}
