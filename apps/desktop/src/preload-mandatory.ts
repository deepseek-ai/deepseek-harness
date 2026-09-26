/** Isolated bridge for the shell-owned mandatory-update modal only. */
import { contextBridge, ipcRenderer } from 'electron'
import type { MandatoryUpdateApi, MandatoryUpdateView } from './mandatory-update-window.ts'
import { MANDATORY_IPC } from './mandatory-update-ipc.ts'

const api: MandatoryUpdateApi = {
  status: () => ipcRenderer.invoke(MANDATORY_IPC.status) as Promise<MandatoryUpdateView>,
  action: (action, version, confirmationRevision) =>
    ipcRenderer.invoke(MANDATORY_IPC.action, action, version, confirmationRevision) as Promise<void>,
  subscribe(listener) {
    const handle = (_event: Electron.IpcRendererEvent, state: MandatoryUpdateView): void => { listener(state) }
    ipcRenderer.on(MANDATORY_IPC.state, handle)
    return () => { ipcRenderer.off(MANDATORY_IPC.state, handle) }
  },
}
if (location.href === 'dsh-app://shell/mandatory-update.html') contextBridge.exposeInMainWorld('dshMandatoryUpdate', api)
