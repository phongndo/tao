import { useQuery } from '@tanstack/react-query'

export function useGitBranch(workspacePath: string | null) {
  return useQuery({
    queryKey: ['workspace', workspacePath, 'branch'],
    enabled: workspacePath !== null,
    queryFn: () => window.electronAPI.getGitBranch(workspacePath ?? ''),
  })
}

export function useGitWorktrees(workspacePath: string | null) {
  return useQuery({
    queryKey: ['workspace', workspacePath, 'worktrees'],
    enabled: workspacePath !== null,
    queryFn: () => window.electronAPI.getGitWorktrees(workspacePath ?? ''),
  })
}
