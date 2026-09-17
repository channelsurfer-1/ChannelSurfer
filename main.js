process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true';

const { app } = require('electron');

app.commandLine.appendSwitch('disable-features', 'HardwareMediaKeyHandling,MediaSessionService');

const { BrowserWindow, session, ipcMain, protocol } = require('electron');
const path = require('path');
const fs = require('fs');
const debug = require('./src/debug');

app.commandLine.appendSwitch('log-level', '3');
app.commandLine.appendSwitch('disable-logging');
// app.commandLine.appendSwitch('disable-webrtc');
app.commandLine.appendSwitch('user-agent', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36');

let win = null;
let windowCreated = false;
let schedulePath = '';
let blockedDomainsLogged = new Set();
let streamPlayerDomains = new Set();
const trackedStreamWebviews = new Set();

// ---------- Logging ----------
function log(category, message) {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  const tag = `[${hh}:${mm}:${ss}] [${category.padEnd(6)}]`;
  console.log(`${tag} ${message}`);
}
// ---------- End logging ----------

// ---------- Remote config ----------
const CONFIG_URL = 'https://gist.githubusercontent.com/channelsurfer-1/cf46021791c0140d8321675b2fcead7b/raw/config.json';
const CONFIG_FETCH_TIMEOUT_MS = 5000;

const BASELINE_CONFIG = {
  baseStreamUrls: [
    'https://dlive.sx/stream/stream-',
    'https://dlstreams.st/watch/stream-',
    'https://dlhd.st/stream/stream-',
    'https://dlive.sx/watch/stream-'
  ],
  safeDomains: [
    'dlhd.st',
    'dlstreams.st',
    'dlive.sx'
  ]
};

let activeConfig = BASELINE_CONFIG;

function getConfigCachePath() {
  return path.join(app.getPath('userData'), 'config.json');
}

function validateConfig(obj) {
  if (!obj || typeof obj !== 'object') return null;
  if (!Array.isArray(obj.baseStreamUrls) || obj.baseStreamUrls.length === 0) return null;
  if (!Array.isArray(obj.safeDomains) || obj.safeDomains.length === 0) return null;
  for (const u of obj.baseStreamUrls) if (typeof u !== 'string' || !u) return null;
  for (const d of obj.safeDomains) if (typeof d !== 'string' || !d) return null;
  return { baseStreamUrls: obj.baseStreamUrls, safeDomains: obj.safeDomains };
}

async function fetchWithTimeout(url, ms) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(`${url}?_=${Date.now()}`, { signal: controller.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

function readCachedConfig() {
  try {
    const p = getConfigCachePath();
    if (!fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p, 'utf8');
    return validateConfig(JSON.parse(raw));
  } catch (err) {
    log('ERROR', 'Failed to read config cache: ' + err.message);
    return null;
  }
}

function writeCachedConfig(config) {
  try {
    const p = getConfigCachePath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(config, null, 2), 'utf8');
  } catch (err) {
    log('ERROR', 'Failed to write config cache: ' + err.message);
  }
}

async function loadConfig() {
  try {
    const remote = await fetchWithTimeout(CONFIG_URL, CONFIG_FETCH_TIMEOUT_MS);
    const validated = validateConfig(remote);
    if (validated) {
      log('CONFIG', 'Loaded from remote');
      writeCachedConfig(validated);
      return validated;
    }
    log('WARN', 'Remote config payload invalid, ignoring');
  } catch (err) {
    log('WARN', 'Remote config fetch failed: ' + err.message);
  }

  const cached = readCachedConfig();
  if (cached) {
    log('CONFIG', 'Loaded from cache');
    return cached;
  }

  log('CONFIG', 'Using hardcoded baseline');
  return BASELINE_CONFIG;
}
// ---------- End remote config ----------

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
    log('START', 'Security log reset');
  } catch (err) {
    log('ERROR', 'Failed to reset security log: ' + err.message);
  }
}

function writeSecurityLog(entry) {
  try {
    const logPath = getSecurityLogPath();
    const line = `${new Date().toISOString()} ${entry}\n`;
    fs.appendFileSync(logPath, line);
  } catch (err) {
    log('ERROR', 'Failed to write security log: ' + err.message);
  }
}

function isStreamPlayerPage(url) {
  try {
    const pathname = new URL(url).pathname;
    return (pathname.includes('/stream/stream-') || pathname.includes('/watch/stream-')) && pathname.endsWith('.php');
  } catch (_) {
    return false;
  }
}

function isStreamingContent(url) {
  return url.includes('.m3u8') || 
         url.includes('.zst') || 
         url.includes('.ts') || 
         url.includes('.key') ||
         url.includes('.pdf');
}

// ---------- Debug-mode helpers (produce no output when debug is disabled) ----------
// Requests referred by these shell hosts are considered known noise for debug
// logging. Streaming content is never treated as noise.
const DEBUG_NOISE_REFERRERS = ['dlhd.st', 'dlstreams.st', 'dlive.sx', 'iplayer.is', 'summertisaridicu.org'];

function truncateUrl(url, max) {
  return url.length > max ? url.slice(0, max) + '...' : url;
}

function isDebugNoise(details) {
  if (details.url.includes('.m3u8') || isStreamingContent(details.url)) return false;
  try {
    const refHost = details.referrer ? new URL(details.referrer).hostname.toLowerCase() : '';
    if (!refHost) return false;
    return DEBUG_NOISE_REFERRERS.some(d => refHost === d || refHost.endsWith('.' + d));
  } catch (_) {
    return false;
  }
}
// ---------- End debug-mode helpers ----------

function isSafeDomain(url) {
  if (isStreamPlayerPage(url) || isStreamingContent(url)) {
    return true;
  }

  try {
    const hostname = new URL(url).hostname.toLowerCase();

    for (const domain of activeConfig.safeDomains) {
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
      log('EPG', 'Schedule regenerated');
      return schedulePath;
    })
    .catch(err => {
      log('ERROR', 'Schedule regeneration failed: ' + err.message);
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
      log('ERROR', 'Scheduled regeneration failed: ' + err.message);
    });

    setInterval(() => {
      generateSchedule().catch(err => {
        log('ERROR', 'Scheduled regeneration failed: ' + err.message);
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
    show: false,
    backgroundColor: '#1a1a1a',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'src', 'preload.js'),
      webSecurity: false,
      allowRunningInsecureContent: false,
      webviewTag: true
    }
  });

  const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';
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
          if (debug.enabled && !isDebugNoise(details)) {
            let reqRefHost = '';
            try { reqRefHost = details.referrer ? new URL(details.referrer).hostname : ''; } catch (_) {}
            log('REQ', `${(details.resourceType || 'unknown').padEnd(8)} ${hostname}${reqRefHost ? '  ref=' + reqRefHost : ''}`);
          }
          callback({ cancel: false });
          return;
        }

        if (!blockedDomainsLogged.has(hostname)) {
          blockedDomainsLogged.add(hostname);
          const entry = `[AUTO-BLOCKED] ${hostname} ${details.resourceType} ${details.url.slice(0, 160)}`;
          let refHost = '';
          try { refHost = details.referrer ? new URL(details.referrer).hostname : ''; } catch (_) {}
          log('BLOCK', `${(details.resourceType || 'unknown').padEnd(8)} ${hostname}${refHost ? '  ref=' + refHost : ''}`);
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

        if (details.url.includes('.m3u8')) {
          if (debug.enabled) {
            log('HDR', 'm3u8 req ' + truncateUrl(details.url, 130));
            log('HDR', '  wire-in UA=' + (headers['User-Agent'] || headers['user-agent'] || '(none)'));
            log('HDR', '  wire-in Referer=' + (headers['Referer'] || headers['referer'] || '(none)') + ' Origin=' + (headers['Origin'] || headers['origin'] || '(none)'));
            log('HDR', '  rebuilt to 4-header curl-parity set');
          }
          callback({ cancel: false, requestHeaders: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36',
            'Accept': '*/*',
            'Origin': 'https://tiestep.top',
            'Referer': 'https://tiestep.top/'
          }});
          return;
        }

        if (details.resourceType === 'mainFrame' && !headers['Referer'] && !headers['referer']) {
          headers['Referer'] = 'https://dlhd.st/';
        }

        headers['sec-ch-ua'] = '"Google Chrome";v="153", "Not_A Brand";v="8", "Chromium";v="153"';
        headers['sec-ch-ua-mobile'] = '?0';
        headers['sec-ch-ua-platform'] = '"macOS"';
        headers['Accept-Language'] = 'en-US,en;q=0.6';
        headers['Sec-GPC'] = '1';

        if (debug.enabled && isStreamingContent(details.url)) {
          log('HDR', `${(details.resourceType || '').padEnd(8)} ${truncateUrl(details.url, 120)}`);
          log('HDR', `  out UA=${(headers['User-Agent'] || headers['user-agent'] || '(none)')}`);
          log('HDR', `  out Referer=${headers['Referer'] || headers['referer'] || '(none)'} Origin=${headers['Origin'] || headers['origin'] || '(none)'}`);
        }

        callback({ cancel: false, requestHeaders: headers });
      } catch (err) {
        callback({ cancel: false });
      }
    }
  );
        
  session.defaultSession.webRequest.onCompleted(
    { urls: ['*://*/*'] },
    (details) => {
      try {
        if (debug.enabled) {
          const interesting = isStreamingContent(details.url) || details.statusCode >= 400 || !isSafeDomain(details.url);
          if (interesting && !isDebugNoise(details)) {
            log('RESP', `${String(details.statusCode).padEnd(4)} ${(details.resourceType || '').padEnd(8)} ${truncateUrl(details.url, 130)}`);
          }
        }
        if (!details.url.includes('.m3u8')) return;
        if (!trackedStreamWebviews.has(details.webContentsId)) return;
        if (details.statusCode >= 400) return;
        if (win && !win.isDestroyed()) {
          win.webContents.send('stream-attempt-success', {
            webContentsId: details.webContentsId
          });
        }
      } catch (_) {}
    }
  );
  
  session.defaultSession.webRequest.onHeadersReceived(
    { urls: ['http://*/*', 'https://*/*'] },
    (details, callback) => {
      try {
        const out = {};
        let acao = null;
        for (const [k, v] of Object.entries(details.responseHeaders || {})) {
          if (k.toLowerCase() === 'access-control-allow-origin') {
            if (acao === null && Array.isArray(v) && v.length > 0) acao = v[0];
          } else {
            out[k] = v;
          }
        }
        out['Access-Control-Allow-Origin'] = [acao || '*'];
        callback({ cancel: false, responseHeaders: out });
      } catch (err) {
        callback({ cancel: false });
      }
    }
  );
  
  const targetPath = path.join(__dirname, 'public', 'index.html');

  win.loadFile(targetPath).catch(err => {
    log('ERROR', 'Failed to load HTML file: ' + err.message);
  });

  setTimeout(() => {
    if (win && !win.isVisible()) {
      log('WARN', 'Schedule render timed out; showing window anyway');
      win.show();
    }
  }, 10000);
}

ipcMain.handle('get-schedule-path', () => schedulePath);
ipcMain.handle('get-stream-base-urls', () => {
  log('CONFIG', 'Renderer requested ' + activeConfig.baseStreamUrls.length + ' base URL candidates');
  return activeConfig.baseStreamUrls;
});

ipcMain.handle('get-debug-mode', () => {
  if (debug.enabled) {
    log('DEBUG', 'Renderer confirmed debug mode via IPC');
  }
  return debug.enabled;
});

ipcMain.on('register-stream-attempt', (event, payload) => {
  if (payload && typeof payload.webContentsId === 'number') {
    trackedStreamWebviews.add(payload.webContentsId);
  }
});

ipcMain.on('unregister-stream-attempt', (event, payload) => {
  if (payload && typeof payload.webContentsId === 'number') {
    trackedStreamWebviews.delete(payload.webContentsId);
  }
});

ipcMain.on('renderer-log', (event, message) => {
  if (typeof message === 'string') {
    log('RENDER', message);
  }
});

ipcMain.on('schedule-rendered', () => {
  if (win && !win.isVisible()) {
    win.show();
  }
});

app.on('web-contents-created', (event, contents) => {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  if (contents.getType() === 'webview') {
    contents.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36');
    if (debug.enabled) {
      contents.on('did-navigate', (e, url) => {
        log('NAV', `NAV  wc=${contents.id} ${truncateUrl(url, 130)}`);
      });
      contents.on('did-fail-provisional-load', (e, errorCode, errorDescription, url) => {
        log('NAV', `FAIL wc=${contents.id} code=${errorCode} ${errorDescription} ${truncateUrl(url, 110)}`);
      });
      contents.on('did-fail-load', (e, errorCode, errorDescription, url, isMainFrame) => {
        if (isMainFrame) {
          log('NAV', `FAIL wc=${contents.id} code=${errorCode} ${errorDescription} ${truncateUrl(url, 110)}`);
        }
      });
    }
  }
});

app.whenReady().then(async () => {
  session.defaultSession.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36');

  resetSecurityLog();

  activeConfig = await loadConfig();
  log('CONFIG', 'Active safeDomains: ' + activeConfig.safeDomains.join(', '));
  if (debug.enabled) {
    log('DEBUG', 'Debug logging enabled (CHANNELSURFER_DEBUG=1 or --debug)');
    log('CONFIG', 'baseStreamUrls: ' + activeConfig.baseStreamUrls.join(' | '));
  }

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
