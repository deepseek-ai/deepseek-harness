/** Isolated response-only bridge for shell-owned update dialogs. */
import { contextBridge, ipcRenderer } from 'electron'
import { UPDATE_DIALOG_IPC, type UpdateDialogApi, type UpdateDialogView } from './update-dialog.ts'

const api: UpdateDialogApi = {
  status: () => ipcRenderer.invoke(UPDATE_DIALOG_IPC.status) as Promise<UpdateDialogView | null>,
  respond: (revision, index) => ipcRenderer.invoke(UPDATE_DIALOG_IPC.respond, revision, index) as Promise<void>,
  subscribe: (listener) => {
    const receive = (_event: Electron.IpcRendererEvent, view: UpdateDialogView | null): void => { listener(view) }
    ipcRenderer.on(UPDATE_DIALOG_IPC.changed, receive)
    return () => { ipcRenderer.removeListener(UPDATE_DIALOG_IPC.changed, receive) }
  },
}
if (location.href === 'dsh-app://shell/update-dialog.html') contextBridge.exposeInMainWorld('dshUpdateDialog', api)
