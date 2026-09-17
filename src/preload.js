const { contextBridge, ipcRenderer } = require('electron');

const SEND_ALLOWED = ['register-stream-attempt', 'unregister-stream-attempt', 'renderer-log', 'schedule-rendered'];
const INVOKE_ALLOWED = ['get-schedule-path', 'get-stream-base-urls'];

contextBridge.exposeInMainWorld('channelSurfer', {
  send(channel, payload) {
    if (SEND_ALLOWED.includes(channel)) {
      ipcRenderer.send(channel, payload);
    }
  },
  invoke(channel) {
    if (INVOKE_ALLOWED.includes(channel)) {
      return ipcRenderer.invoke(channel);
    }
    return Promise.reject(new Error('channel not allowed: ' + channel));
  },
  onStreamSuccess(handler) {
    ipcRenderer.on('stream-attempt-success', (event, payload) => handler(payload));
  }
});