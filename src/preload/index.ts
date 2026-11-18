import { contextBridge, ipcRenderer } from 'electron'
import type { KokoroApi } from '../shared/types'

const on =
  (channel: string) =>
  (cb: (...args: any[]) => void): void => {
    ipcRenderer.on(channel, (_e, ...args) => cb(...args))
  }

const api: KokoroApi = {
  windows: process.platform === 'win32',
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  getStatus: () => ipcRenderer.invoke('status:get'),
  preview: () => ipcRenderer.send('preview'),
  suspendHotkey: (suspend) => ipcRenderer.send('hotkey:suspend', suspend),
  stop: () => ipcRenderer.send('stop'),
  playbackStarted: (id) => ipcRenderer.send('reader:playback-started', id),
  playbackPaused: (id, paused) => ipcRenderer.send('reader:playback-paused', id, paused),
  playbackFailed: (id, message) => ipcRenderer.send('reader:playback-failed', id, message),
  controlPlayback: (command) => ipcRenderer.send('playback-controls:command', command),
  regenerateForSeek: (id, generationId, startSeq) => ipcRenderer.send('reader:regenerate', id, generationId, startSeq),
  reportWord: (id, from, to, text) => ipcRenderer.send('reader:word', id, from, to, text),
  finished: (id) => ipcRenderer.send('reader:finished', id),
  onReaderStart: on('reader:start'),
  onReaderSpeed: on('reader:speed'),
  onChunk: on('reader:chunk'),
  onDone: on('reader:done'),
  onStop: on('reader:stop'),
  onMessage: on('reader:message'),
  onError: on('reader:error'),
  onStatus: on('status'),
  onPreparationShortcut: on('preparing:shortcut'),
  onPlaybackPaused: on('playback-controls:paused'),
  onPlaybackCommand: on('reader:command')
}

contextBridge.exposeInMainWorld('kokoro', api)
