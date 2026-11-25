import type { ChatMessage, MockRoutine, MockTool, WorkspaceBot } from '../types/workspace.ts'

export const MOCK_MODELS = [
  { id: 'gpt-6.2-mock', label: 'GPT-6.2 (Mock)', efforts: ['low', 'medium', 'high'] },
  { id: 'codex-mock', label: 'Codex (Mock)', efforts: ['low', 'medium', 'high'] },
] as const

export const MOCK_TEAMS = [
  { id: 'team-dev', name: 'Dev Team' },
  { id: 'team-personal', name: 'Personal Team' },
] as const

export const INITIAL_MOCK_BOTS: WorkspaceBot[] = [
  {
    id: 'chief',
    name: 'Chief of Staff',
    statusLabel: 'Working...',
    avatarStatus: 'working',
    avatar: { shape: 'chief', color: '#A3835D', eyes: 'classic', rotation: 0, animation: true },
    instructions: 'Coordinate tasks across your workspace bots and summarize next actions.',
    workspacePath: '~/Projects/ghost-bot (mock)',
    modelId: 'gpt-6.2-mock',
    effort: 'medium',
    permission: 'ask-approval',
  },
  {
    id: 'developer',
    name: 'Developer',
    statusLabel: 'Ready',
    avatarStatus: 'idle',
    avatar: { shape: 'developer', color: '#7765CF', eyes: 'classic', rotation: 0, animation: true },
    instructions: 'Inspect code, run tests, and prepare minimal diffs.',
    workspacePath: '~/Projects/ghost-bot (mock)',
    modelId: 'codex-mock',
    effort: 'medium',
    permission: 'ask-approval',
  },
  {
    id: 'researcher',
    name: 'Researcher',
    statusLabel: 'Ready',
    avatarStatus: 'idle',
    avatar: { shape: 'researcher', color: '#418D79', eyes: 'round', rotation: 0, animation: true },
    instructions: 'Gather documentation and summarize technical findings.',
    workspacePath: '~/Projects/ghost-bot (mock)',
    modelId: 'gpt-6.2-mock',
    effort: 'high',
    permission: 'read-only',
  },
  {
    id: 'email-assistant',
    name: 'Email Assistant',
    statusLabel: 'Scheduled',
    avatarStatus: 'sleeping',
    avatar: { shape: 'automation', color: '#E89042', eyes: 'sleepy', rotation: 0, animation: true },
    instructions: 'Draft inbox summaries for explicit user review.',
    workspacePath: '~/Documents (mock)',
    modelId: 'gpt-6.2-mock',
    effort: 'low',
    permission: 'read-only',
  },
  {
    id: 'daily-assistant',
    name: 'Daily Assistant',
    statusLabel: 'Ready',
    avatarStatus: 'completed',
    avatar: { shape: 'assistant', color: '#438ECE', eyes: 'happy', rotation: 0, animation: true },
    instructions: 'Keep track of daily priorities and personal notes.',
    workspacePath: '~/Notes (mock)',
    modelId: 'gpt-6.2-mock',
    effort: 'low',
    permission: 'read-only',
  },
]

export const INITIAL_MOCK_MESSAGES: Record<string, ChatMessage[]> = {
  chief: [
    {
      id: 'm1',
      role: 'user',
      text: "Review my GitHub projects and plan tomorrow's tasks.",
      timestamp: 'Today · 7:30 PM',
    },
    {
      id: 'm2',
      role: 'assistant',
      text: "I'll coordinate with your Developer bot and prepare a summary.",
      timestamp: 'Today · 7:30 PM',
      tools: [
        { id: 't1', label: 'Read project files', status: 'done' },
        { id: 't2', label: 'Delegated to Developer', status: 'done' },
        { id: 't3', label: 'Analyzing pending tasks', status: 'running' },
      ],
      approval: {
        id: 'app-1',
        title: 'Approval required',
        description: 'Developer wants to edit ROADMAP.md',
        diffTitle: 'ROADMAP.md (simulated preview)',
        diffText:
          '--- a/docs/ROADMAP.md\n+++ b/docs/ROADMAP.md\n@@ -15,3 +15,4 @@\n - [x] Secure IPC, daemon lifecycle\n+- [ ] Verify Phase 1B three-panel UI layout',
        decision: 'pending',
      },
    },
  ],
  developer: [],
  researcher: [
    {
      id: 'r1',
      role: 'user',
      text: 'Summarize the Phase 1 security checklist.',
      timestamp: 'Today · 6:15 PM',
    },
    {
      id: 'r2',
      role: 'assistant',
      text: 'Renderer stays sandboxed with contextIsolation enabled, no Node integration, strict CSP, and Zod-validated IPC.',
      timestamp: 'Today · 6:15 PM',
    },
  ],
  'email-assistant': [],
  'daily-assistant': [],
}

export const MOCK_ROUTINES: MockRoutine[] = [
  { id: 'rt-1', name: 'Morning briefing', schedule: 'Daily · 8:00 AM' },
  { id: 'rt-2', name: 'Project review', schedule: 'Every Monday' },
]

export const MOCK_TOOLS: MockTool[] = [
  { id: 'tl-1', name: 'GitHub', kind: 'github', note: 'mock' },
  { id: 'tl-2', name: 'Terminal', kind: 'terminal', note: 'mock' },
  { id: 'tl-3', name: 'Local files', kind: 'files', note: 'mock' },
]
