import { contextBridge, ipcRenderer } from 'electron'
import type { GhostBotBridge } from '@ghost-bot/shared-types/ipc'

const bridge: GhostBotBridge = {
  getAppInfo: () => ipcRenderer.invoke('ghost:app:info', {}),
  getDaemonHealth: () => ipcRenderer.invoke('ghost:daemon:health', {}),
  listProviders: () => ipcRenderer.invoke('ghost:providers:list', {}),
}

contextBridge.exposeInMainWorld('ghostBot', bridge)
