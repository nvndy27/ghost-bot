import type { WorkspaceTabId } from '@ghost-bot/shared-types/ipc'
import type { AvatarConfig } from '@ghost-bot/avatar/presets'
import type { PermissionMode } from '@ghost-bot/shared-types/runtime'

export type AvatarStatus =
  | 'idle'
  | 'thinking'
  | 'working'
  | 'approval'
  | 'sleeping'
  | 'completed'
  | 'error'

export type ThemePreference = 'system' | 'dark' | 'light'

export interface UiPreferences {
  theme: ThemePreference
  leftWidth: number
  rightWidth: number
  leftCollapsed: boolean
  rightCollapsed: boolean
  workspaceTab: WorkspaceTabId
  reducedMotion: boolean
}

export interface ToolStep {
  id: string
  label: string
  status: 'done' | 'running' | 'failed'
}

export interface PendingApproval {
  id: string
  title: string
  description: string
  diffTitle: string
  diffText: string
  actionType?: string
  argsHash?: string
  permissionMode?: string
  expiresAt?: string
  isMock?: boolean
  decision:
    | 'pending'
    | 'resolving'
    | 'approved'
    | 'denied'
    | 'expired'
    | 'revoked'
    | 'resolution_failed'
}

export type ChatMessage =
  | {
      id: string
      role: 'user'
      text: string
      timestamp: string
    }
  | {
      id: string
      role: 'assistant'
      text: string
      streaming?: boolean
      timestamp: string
      tools?: ToolStep[]
      approval?: PendingApproval
    }

export interface WorkspaceBot {
  id: string
  name: string
  description?: string
  runtimeId?: string
  updatedAt?: string
  statusLabel: string
  avatarStatus: AvatarStatus
  avatar: AvatarConfig
  instructions: string
  workspacePath: string
  modelId: string
  effort: string
  permission: PermissionMode
}

export interface MockRoutine {
  id: string
  name: string
  schedule: string
}

export interface MockTool {
  id: string
  name: string
  kind: 'github' | 'terminal' | 'files'
  note: string
}
