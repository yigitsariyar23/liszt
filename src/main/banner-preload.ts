import { contextBridge, ipcRenderer } from 'electron';

// A notification banner's only line back to the app: open its session, dismiss it, or hold it while hovered.
contextBridge.exposeInMainWorld('banner', {
  act: (action: 'open' | 'dismiss' | 'hold' | 'release') => ipcRenderer.send('banner', action),
});
