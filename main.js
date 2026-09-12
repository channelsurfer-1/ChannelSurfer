const { app } = require('electron');

app.commandLine.appendSwitch('disable-features', 'HardwareMediaKeyHandling,MediaSessionService');

const { BrowserWindow, session, ipcMain, protocol } = require('electron');
const path = require('path');
const fs = require('fs');

app.commandLine.appendSwitch('log-level', '3');
app.commandLine.appendSwitch('disable-logging');
app.commandLine.appendSwitch('disable-webrtc');

let win = null;
let windowCreated = false;
let schedulePath = '';
let blockedDomainsLogged = new Set();
let streamPlayerDomains = new Set();

const SAFE_DOMAINS = [
  'dlhd.st',
  'dlstreams.st',
  'hamis.romponalis.st',
  'xameleon.phantemlis.top',
  'r2.cloudflarestorage.com',
  'cdn.jsdelivr.net',
  'ann.cdn-lab.shop',
  'dromlis.vmalplapis.cfd',
  'vmalplapis.cfd',
  'gomis.phzampelis.cfd'
];

function getSecurityLogPath() {
  const dataDir = app.isPackaged
    ? app.getPath('userData')
    : path.join(__dirname, 'data');
  
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  
  return path.join(dataDir, 'security.log');
}

function resetSecurityLog() {
  try {
    const logPath = getSecurityLogPath();
    fs.writeFileSync(logPath, '');
    console.log('Security log reset.');
  } catch (err) {
    console.error('Failed to reset security log:', err.message);
  }
}

function writeSecurityLog(entry) {
  try {
    const logPath = getSecurityLogPath();
    const line = `${new Date().toISOString()} ${entry}\n`;
    fs.appendFileSync(logPath, line);
  } catch (err) {
    console.error('Failed to write security log:', err.message);
  }
}

function isStreamPlayerPage(url) {
  return url.includes('/stream/stream-') && url.endsWith('.php');
}

function isStreamingContent(url) {
  return url.includes('.m3u8') || 
         url.includes('.zst') || 
         url.includes('.ts') || 
         url.includes('.key') ||
         url.includes('.pdf');
}

function isSafeDomain(url) {
  if (isStreamPlayerPage(url) || isStreamingContent(url)) {
    return true;
  }
  
  try {
    const hostname = new URL(url).hostname.toLowerCase();

    for (const domain of SAFE_DOMAINS) {
      if (hostname === domain || hostname.endsWith('.' + domain)) {
        return true;
      }
    }
    
    if (streamPlayerDomains.has(hostname)) {
      return true;
    }
  } catch (_) {}

  return false;
}

function generateSchedule() {
  const { fetchEpg } = require('./src/fetchEpg');
  const { generateScheduleJson } = require('./src/generateScheduleJson');

  return fetchEpg()
    .then(() => {
      schedulePath = generateScheduleJson();
      console.log('Schedule regenerated at', new Date().toISOString());
      return schedulePath;
    })
    .catch(err => {
      console.error('Schedule regeneration failed:', err.message);
      return schedulePath;
    });
}

function scheduleHalfHourRegeneration() {
  const now = new Date();
  const minutes = now.getMinutes();
  const seconds = now.getSeconds();
  const ms = now.getMilliseconds();

  const nextHalfHour = minutes < 30 ? 30 : 60;
  const minutesUntilRefresh = nextHalfHour - minutes;
  const delay = (minutesUntilRefresh * 60 * 1000) - (seconds * 1000) - ms;

  setTimeout(() => {
    generateSchedule().catch(err => {
      console.error('Scheduled regeneration failed:', err.message);
    });

    setInterval(() => {
      generateSchedule().catch(err => {
        console.error('Scheduled regeneration failed:', err.message);
      });
    }, 30 * 60 * 1000);
  }, delay);
}

function createWindow() {
  if (windowCreated) return;
  windowCreated = true;

  win = new BrowserWindow({
    title: '📺 ChannelSurfer',
    width: 1200,
    height: 800,
    show: false,  // Don't show until content is ready
    backgroundColor: '#1a1a1a',  // Match your app's background color
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      webSecurity: false,
      allowRunningInsecureContent: false,
      webviewTag: true
    }
  });

  const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';
  win.webContents.setUserAgent(USER_AGENT);

  session.defaultSession.clearCache().catch(() => {});

  session.defaultSession.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*'] },
    (details, callback) => {
      try {
        const parsed = new URL(details.url);
        const hostname = parsed.hostname.toLowerCase();
        
        if (isStreamPlayerPage(details.url)) {
          streamPlayerDomains.add(hostname);
        }

        if (isSafeDomain(details.url)) {
          callback({ cancel: false });
          return;
        }

        if (!blockedDomainsLogged.has(hostname)) {
          blockedDomainsLogged.add(hostname);
          const entry = `[AUTO-BLOCKED] ${hostname} ${details.resourceType} ${details.url.slice(0, 160)}`;
          console.log(entry);
          writeSecurityLog(entry);
        }

        callback({ cancel: true });
      } catch (_) {
        callback({ cancel: false });
      }
    }
  );

  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: ['http://*/*', 'https://*/*'] },
    (details, callback) => {
      try {
        const headers = details.requestHeaders || {};
        headers['User-Agent'] = USER_AGENT;
        headers['sec-gpc'] = '1';

        const requestUrl = details.url;

        if (
          requestUrl.includes('.m3u8') ||
          requestUrl.includes('.ts') ||
          requestUrl.includes('.key') ||
          requestUrl.includes('.zst') ||
          requestUrl.includes('.pdf') ||
          details.resourceType === 'media'
        ) {
          if (!headers['Referer'] && !headers['referer']) {
            const parsed = new URL(requestUrl);
            headers['Referer'] = `${parsed.protocol}//${parsed.host}/`;
          }
        } else {
          headers['Referer'] = 'https://dlhd.st/';
          headers['Origin'] = 'https://dlhd.st';
        }

        callback({ cancel: false, requestHeaders: headers });
      } catch (err) {
        callback({ cancel: false });
      }
    }
  );

  win.webContents.setWindowOpenHandler(() => {
    return { action: 'allow' };
  });

  const targetPath = path.join(__dirname, 'public', 'index.html');

  win.loadFile(targetPath).catch(err => {
    console.error('Failed to load HTML file:', err);
  });

  // Window is shown by the 'schedule-rendered' IPC event after the first render.
  // Safety fallback: show the window after 10 seconds if the renderer never signals.
  setTimeout(() => {
    if (win && !win.isVisible()) {
      console.warn('Schedule render timed out; showing window anyway.');
      win.show();
    }
  }, 10000);
}

ipcMain.handle('get-schedule-path', () => schedulePath);

ipcMain.on('schedule-rendered', () => {
  if (win && !win.isVisible()) {
    win.show();
  }
});

app.whenReady().then(async () => {
  resetSecurityLog();

  // Register custom protocol for serving images from the images/ directory
  protocol.registerFileProtocol('app', (request, callback) => {
    const url = request.url.substr(6);
    const imagePath = path.join(__dirname, 'images', url);
    callback({ path: imagePath });
  });

  schedulePath = await generateSchedule();
  createWindow();

  scheduleHalfHourRegeneration();
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});