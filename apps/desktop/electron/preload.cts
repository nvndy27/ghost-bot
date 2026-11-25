import { contextBridge, ipcRenderer } from 'electron'
import type { GhostBotBridge } from '@ghost-bot/shared-types/ipc'

const bridge: GhostBotBridge = {
  getAppInfo: () => ipcRenderer.invoke('ghost:app:info', {}),
  getDaemonHealth: () => ipcRenderer.invoke('ghost:daemon:health', {}),
  listProviders: () => ipcRenderer.invoke('ghost:providers:list', {}),
  listBots: () => ipcRenderer.invoke('ghost:bots:list', {}),
  createBot: (input) => ipcRenderer.invoke('ghost:bots:create', input),
  updateBot: (input) => ipcRenderer.invoke('ghost:bots:update', input),
  duplicateBot: (id) => ipcRenderer.invoke('ghost:bots:duplicate', { id }),
  deleteBot: (id) => ipcRenderer.invoke('ghost:bots:delete', { id }),
  setActiveBot: (id) => ipcRenderer.invoke('ghost:bots:set-active', { id }),
  importAvatarSvg: (rawSvg, label) =>
    ipcRenderer.invoke('ghost:avatar:import-svg', { rawSvg, label }),
  pickWorkspace: () => ipcRenderer.invoke('ghost:workspace:pick', {}),
  getSettings: () => ipcRenderer.invoke('ghost:settings:get', {}),
  updateSettings: (patch) => ipcRenderer.invoke('ghost:settings:update', patch),
  resetSettings: () => ipcRenderer.invoke('ghost:settings:reset', {}),
  migrateLocalSettings: (legacy) => ipcRenderer.invoke('ghost:settings:migrate-local', legacy),
  getRuntimeSnapshot: (refresh) =>
    ipcRenderer.invoke('ghost:runtime:snapshot', refresh !== undefined ? { refresh } : {}),
  listSessions: (params) => ipcRenderer.invoke('ghost:sessions:list', params),
  createSession: (input) => ipcRenderer.invoke('ghost:sessions:create', input),
  renameSession: (input) => ipcRenderer.invoke('ghost:sessions:rename', input),
  archiveSession: (sessionId) => ipcRenderer.invoke('ghost:sessions:archive', { sessionId }),
  setActiveSession: (input) => ipcRenderer.invoke('ghost:sessions:set-active', input),
  listMessages: (params) => ipcRenderer.invoke('ghost:messages:list', params),
  startRun: (input) => ipcRenderer.invoke('ghost:runs:start', input),
  getRun: (runId) => ipcRenderer.invoke('ghost:runs:get', { runId }),
  cancelRun: (runId) => ipcRenderer.invoke('ghost:runs:cancel', { runId }),
  getRunEvents: (params) => ipcRenderer.invoke('ghost:runs:events', params),
  resolveApproval: (input) => ipcRenderer.invoke('ghost:runs:resolve-approval', input),
}

contextBridge.exposeInMainWorld('ghostBot', bridge)
