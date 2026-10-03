import { contextBridge, ipcRenderer } from 'electron'
import type { KokoroApi } from '../shared/types'

const on =
  (channel: string) =>
  (cb: (...args: any[]) => void): void => {
    ipcRenderer.on(channel, (_e, ...args) => cb(...args))
  }

const api: KokoroApi = {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  getStatus: () => ipcRenderer.invoke('status:get'),
  preview: () => ipcRenderer.send('preview'),
  suspendHotkey: (suspend) => ipcRenderer.send('hotkey:suspend', suspend),
  stop: () => ipcRenderer.send('stop'),
  reportWord: (id, from, to, text) => ipcRenderer.send('reader:word', id, from, to, text),
  finished: (id) => ipcRenderer.send('reader:finished', id),
  onReaderStart: on('reader:start'),
  onChunk: on('reader:chunk'),
  onDone: on('reader:done'),
  onStop: on('reader:stop'),
  onMessage: on('reader:message'),
  onError: on('reader:error'),
  onStatus: on('status')
}

contextBridge.exposeInMainWorld('kokoro', api)
