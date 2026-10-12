const { contextBridge, ipcRenderer } = require('electron');

const SEND_ALLOWED = ['register-stream-attempt', 'unregister-stream-attempt', 'renderer-log', 'schedule-rendered', 'allow-recovery-domains', 'recovery-test-result', 'recovery-soak-failed', 'copy-text', 'webview-bounds', 'set-pane-audio-focus', 'unregister-health', 'drag-arm'];
const INVOKE_ALLOWED = ['get-schedule-path', 'get-stream-base-urls', 'get-debug-mode', 'get-recovery-candidates'];

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
  onStreamHealth(handler) {
    ipcRenderer.on('stream-health', (event, payload) => handler(payload));
  },
  onDragCursor(handler) {
    ipcRenderer.on('drag-cursor', (event, payload) => handler(payload));
  },
  onStreamSuccess(handler) {
    ipcRenderer.on('stream-attempt-success', (event, payload) => handler(payload));
  },
  onRecoveryPromoted(handler) {
    ipcRenderer.on('recovery-promoted', (event, payload) => handler(payload));
  },
  onScheduleReady(handler) {
    ipcRenderer.on('schedule-ready', (event, payload) => handler(payload));
  },
  onScheduleUnavailable(handler) {
    ipcRenderer.on('schedule-unavailable', (event, payload) => handler(payload));
  }
});