import { parsePatchFiles, type FileDiffMetadata } from '@pierre/diffs'

export type ParsedDiffFile = {
  id: string
  path: string
  fileDiff: FileDiffMetadata
  additions: number
  deletions: number
}

export type ParsedDiffResult = {
  files: ParsedDiffFile[]
  error: string | null
}

export function getDiffFileDelta(
  fileDiff: FileDiffMetadata,
): Pick<ParsedDiffFile, 'additions' | 'deletions'> {
  return fileDiff.hunks.reduce(
    (delta, hunk) => ({
      additions: delta.additions + hunk.additionLines,
      deletions: delta.deletions + hunk.deletionLines,
    }),
    { additions: 0, deletions: 0 },
  )
}

export function getDiffFileName(fileDiff: FileDiffMetadata): string {
  return fileDiff.prevName && fileDiff.prevName !== fileDiff.name
    ? `${fileDiff.prevName} -> ${fileDiff.name}`
    : fileDiff.name
}

export function getDiffFilePath(fileDiff: FileDiffMetadata): string {
  return fileDiff.name || fileDiff.prevName || getDiffFileName(fileDiff)
}

export function parseDiffFiles(patch: string, idPrefix: string): ParsedDiffResult {
  if (patch.trim().length === 0) return { files: [], error: null }

  try {
    const files = parsePatchFiles(patch).flatMap((parsedPatch, patchIndex) =>
      parsedPatch.files.map((fileDiff, fileIndex): ParsedDiffFile => {
        const path = getDiffFilePath(fileDiff)
        const id = (
          idPrefix
            ? [idPrefix, patchIndex, fileIndex, fileDiff.prevName ?? '', path]
            : [patchIndex, fileIndex, fileDiff.prevName ?? '', path]
        ).join(':')
        const delta = getDiffFileDelta(fileDiff)
        return { id, path, fileDiff, ...delta }
      }),
    )
    return { files, error: null }
  } catch (parseError) {
    return {
      files: [],
      error: parseError instanceof Error ? parseError.message : String(parseError),
    }
  }
}
