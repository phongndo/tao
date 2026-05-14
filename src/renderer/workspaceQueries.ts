import { useQuery } from '@tanstack/react-query'

export function useGitBranch(workspacePath: string | null, enabled = true) {
  return useQuery({
    queryKey: ['workspace', workspacePath, 'branch'],
    enabled: workspacePath !== null && enabled,
    queryFn: () => window.electronAPI.getGitBranch(workspacePath ?? ''),
  })
}

export function useGitWorktrees(workspacePath: string | null, enabled = true) {
  return useQuery({
    queryKey: ['workspace', workspacePath, 'worktrees'],
    enabled: workspacePath !== null && enabled,
    queryFn: () => window.electronAPI.getGitWorktrees(workspacePath ?? ''),
  })
}
