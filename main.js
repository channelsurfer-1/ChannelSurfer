process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true';

const { app } = require('electron');

app.commandLine.appendSwitch('disable-features', 'HardwareMediaKeyHandling,MediaSessionService');

const { BrowserWindow, session, ipcMain, protocol, clipboard, webContents, screen } = require('electron');
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

const blockedDomainRefs = new Map();
const runtimeAllowedDomains = new Set();
let knownPassengers = new Set();
const chainHosts = new Set();
const shellHosts = new Set();
let pendingPromotion = null;

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

// ---------- Local config additions ----------
function getAdditionsPath() {
  return path.join(app.getPath('userData'), 'config-additions.json');
}

function loadAdditions() {
  try {
    const p = getAdditionsPath();
    if (!fs.existsSync(p)) return { safeDomains: [], passengers: [] };
    const obj = JSON.parse(fs.readFileSync(p, 'utf8'));
    return {
      safeDomains: Array.isArray(obj.safeDomains) ? obj.safeDomains.filter(d => typeof d === 'string' && d) : [],
      passengers: Array.isArray(obj.passengers) ? obj.passengers.filter(d => typeof d === 'string' && d) : []
    };
  } catch (err) {
    log('ERROR', 'Failed to read config additions: ' + err.message);
    return { safeDomains: [], passengers: [] };
  }
}

function saveAdditions(additions) {
  try {
    const p = getAdditionsPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(additions, null, 2), 'utf8');
  } catch (err) {
    log('ERROR', 'Failed to write config additions: ' + err.message);
  }
}
// ---------- End local config additions ----------

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

// ---------- Debug-mode helpers ----------
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

// ---------- Player frame finder ----------
function findPlayerFrame(wc) {
  try {
    const frames = wc.mainFrame.framesInSubtree;
    for (const f of frames) {
      if (f === wc.mainFrame) continue;
      if (!f.url || !/^https?:/i.test(f.url)) continue;
      return f;
    }
  } catch (_) {}
  return null;
}
// ---------- End player frame finder ----------

// ---------- webFrameMain diagnostic probe ----------
const frameProbed = new Set();

function probeTiestepFrame(wcId) {
  if (!debug.enabled) return;
  if (frameProbed.has(wcId)) return;
  const wc = webContents.fromId(wcId);
  if (!wc || wc.isDestroyed()) {
    log('FRAME', 'probe skip: wc ' + wcId + ' not available');
    return;
  }
  frameProbed.add(wcId);

  let frames = [];
  try {
    frames = wc.mainFrame.framesInSubtree;
  } catch (err) {
    log('FRAME', 'framesInSubtree failed: ' + (err && err.message ? err.message : '?'));
    return;
  }

  log('FRAME', 'wc=' + wcId + ' frame count=' + frames.length);
  for (const f of frames) {
    log('FRAME', '  url=' + truncateUrl(f.url || '(no url)', 130));
  }

  const target = findPlayerFrame(wc);
  if (!target) {
    log('FRAME', 'no player frame found in subtree');
    return;
  }
  log('FRAME', '  picked player frame url=' + truncateUrl(target.url || '(no url)', 130));

  const script = `
    (function() {
      const out = { title: document.title, href: location.href, videos: [], unmute: [] };
      for (const v of document.querySelectorAll('video')) {
        out.videos.push({ id: v.id || '', paused: !!v.paused, muted: !!v.muted, rs: v.readyState });
      }
      const el = document.getElementById('unmute');
      if (el) out.unmute.push({ tag: el.tagName, id: el.id, text: (el.textContent || '').trim().slice(0, 40) });
      return out;
    })()
  `;

  target.executeJavaScript(script, false)
    .then((res) => {
      log('FRAME', 'dom: ' + JSON.stringify(res));
    })
    .catch((err) => {
      log('FRAME', 'dom probe failed: ' + (err && err.message ? err.message : '?'));
    });
}
// ---------- End webFrameMain diagnostic probe ----------

// ---------- Curtain hide + click-shield neutralizer ----------
const curtainHidden = new Set();

function hideUnmuteCurtain(wcId) {
  if (curtainHidden.has(wcId)) return;
  const wc = webContents.fromId(wcId);
  if (!wc || wc.isDestroyed()) return;

  const target = findPlayerFrame(wc);
  if (!target) return;

  curtainHidden.add(wcId);

  // Two rules:
  //  1. Hide the #unmute overlay.
  //  2. Neutralize the full-screen transparent click shield the site
  //     injects as a direct child of body with z-index: 2147483647 (max int32).
  //     pointer-events: none lets clicks pass through to the player beneath;
  //     the element itself stays in the DOM in case the site needs it to exist.
  const script = `
    (function() {
      if (document.getElementById('cs-hide-unmute-style')) return false;
      const s = document.createElement('style');
      s.id = 'cs-hide-unmute-style';
      s.textContent =
        '#unmute { display: none !important; }' +
        'div[style*="z-index: 2147483647"] { pointer-events: none !important; }';
      (document.head || document.documentElement).appendChild(s);
      return true;
    })()
  `;

  target.executeJavaScript(script, false)
    .then((injected) => {
      if (debug.enabled) log('UNMUTE', 'curtain + shield neutralized ' + (injected ? 'injected' : 'already present') + ' wc=' + wcId);
    })
    .catch((err) => {
      curtainHidden.delete(wcId);
      if (debug.enabled) log('UNMUTE', 'hide failed: ' + (err && err.message ? err.message : '?'));
    });
}
// ---------- End curtain hide + click-shield neutralizer ----------

// ---------- Player warm-up ----------
const warmedUp = new Set();

function warmUpPlayer(wcId) {
  if (warmedUp.has(wcId)) return;
  const wc = webContents.fromId(wcId);
  if (!wc || wc.isDestroyed()) return;

  const target = findPlayerFrame(wc);
  if (!target) return;

  warmedUp.add(wcId);

  const script = `
    (function() {
      const v = document.querySelector('video') || document.body;
      const r = v && v.getBoundingClientRect ? v.getBoundingClientRect() : { left:0, top:0, width:100, height:100 };
      const x = (r.left || 0) + (r.width || 100) / 2;
      const y = (r.top || 0) + (r.height || 100) / 2;
      const opts = { clientX: x, clientY: y, bubbles: true, cancelable: true, view: window, button: 0 };
      const ev = new MouseEvent('click', opts);
      v.dispatchEvent(ev);
      return true;
    })()
  `;

  target.executeJavaScript(script, true)
    .then(() => {
      if (debug.enabled) log('WARM', 'warm-up click fired wc=' + wcId);
    })
    .catch((err) => {
      warmedUp.delete(wcId);
      if (debug.enabled) log('WARM', 'failed: ' + (err && err.message ? err.message : '?'));
    });
}
// ---------- End player warm-up ----------

// ---------- Click probe (debug-only) ----------
const clickProbed = new Set();

function instrumentClicks(wcId) {
  if (!debug.enabled) return;
  if (clickProbed.has(wcId)) return;
  const wc = webContents.fromId(wcId);
  if (!wc || wc.isDestroyed()) return;

  const target = findPlayerFrame(wc);
  if (!target) return;

  clickProbed.add(wcId);

  const script = `
    (function() {
      if (window.__csClickProbe) return false;
      window.__csClickProbe = true;
      const chain = (el) => {
        const parts = [];
        let n = 0;
        while (el && n++ < 8) {
          const t = el.tagName || '?';
          const id = el.id ? '#' + el.id : '';
          const cls = (el.className && el.className.toString().slice(0, 40).replace(/\\s+/g, '.')) || '';
          parts.push(t + id + (cls ? '.' + cls : ''));
          el = el.parentElement;
        }
        return parts.join(' < ');
      };
      const vstate = () => {
        const v = document.querySelector('video');
        if (!v) return 'no-video';
        return 'muted=' + v.muted + ' vol=' + v.volume.toFixed(2) + ' paused=' + v.paused;
      };
      ['mousedown', 'click'].forEach(kind => {
        document.addEventListener(kind, (e) => {
          try {
            const x = e.clientX, y = e.clientY;
            const stack = (document.elementsFromPoint ? document.elementsFromPoint(x, y) : [])
              .slice(0, 4)
              .map(el => (el.tagName || '?') + (el.id ? '#' + el.id : '') + (el.className ? '.' + el.className.toString().slice(0, 30).replace(/\\s+/g, '.') : ''))
              .join(' | ');
            console.log('[CS-CLICK] ' + kind + ' (' + Math.round(x) + ',' + Math.round(y) + ') ' + vstate());
            console.log('[CS-CLICK]   target-chain: ' + chain(e.target));
            console.log('[CS-CLICK]   stack@point: ' + stack);
            if (kind === 'click') {
              setTimeout(() => {
                try { console.log('[CS-CLICK] after150 ' + vstate()); } catch (_) {}
              }, 150);
            }
          } catch (err) {
            try { console.log('[CS-CLICK] err ' + err.message); } catch (_) {}
          }
        }, true);
      });
      return true;
    })()
  `;

  target.executeJavaScript(script, false)
    .then((injected) => {
      if (debug.enabled) log('CLICK', 'click probe ' + (injected ? 'installed' : 'already present') + ' wc=' + wcId);
    })
    .catch((err) => {
      clickProbed.delete(wcId);
      if (debug.enabled) log('CLICK', 'probe failed: ' + (err && err.message ? err.message : '?'));
    });
}
// ---------- End click probe ----------

// ---------- Cursor-poll control-pulse ----------
const CONTROL_PULSE_GRACE_MS = 4000;

const webviewBounds = new Map();
let cursorPollTimer = null;
let cursorOverWcId = null;
const lastPulseAt = new Map();
let jitterPhase = 0;
let lastCursorX = -1;
let lastCursorY = -1;
let lastMoveAt = 0;

ipcMain.on('webview-bounds', (event, payload) => {
  if (!payload || !Array.isArray(payload.entries)) return;
  if (!win || win.isDestroyed()) return;
  const cb = win.getContentBounds();
  const now = Date.now();
  const seen = new Set();
  for (const e of payload.entries) {
    if (!e || typeof e.webContentsId !== 'number') continue;
    if (typeof e.x !== 'number' || typeof e.y !== 'number' ||
        typeof e.w !== 'number' || typeof e.h !== 'number') continue;
    webviewBounds.set(e.webContentsId, {
      x: cb.x + e.x,
      y: cb.y + e.y,
      w: e.w,
      h: e.h,
      ts: now
    });
    seen.add(e.webContentsId);
  }
  for (const id of Array.from(webviewBounds.keys())) {
    if (!seen.has(id)) webviewBounds.delete(id);
  }
});

function pulseControls(wcId) {
  const now = Date.now();
  const last = lastPulseAt.get(wcId) || 0;
  if (now - last < 100) return;
  lastPulseAt.set(wcId, now);

  const wc = webContents.fromId(wcId);
  if (!wc || wc.isDestroyed()) return;

  const target = findPlayerFrame(wc);
  if (!target) return;

  jitterPhase = (jitterPhase + 1) % 8;
  const jx = jitterPhase;
  const jy = (jitterPhase * 3) % 5;

  const script = `
    (function() {
      const v = document.querySelector('video');
      const r = v ? v.getBoundingClientRect() : { left: 0, top: 0, width: 200, height: 200 };
      const jx = ${jx};
      const jy = ${jy};
      const x = r.left + r.width / 2 + jx;
      const y = r.top + r.height / 2 + jy;
      const opts = { clientX: x, clientY: y, bubbles: true, cancelable: true, view: window };
      document.dispatchEvent(new MouseEvent('mousemove', opts));
      if (v) {
        v.dispatchEvent(new MouseEvent('mousemove', opts));
        v.dispatchEvent(new MouseEvent('mouseover', opts));
      }
      return true;
    })()
  `;
  target.executeJavaScript(script, false).catch(() => {});
}

function startCursorPoll() {
  if (cursorPollTimer) return;
  cursorPollTimer = setInterval(() => {
    if (webviewBounds.size === 0) {
      cursorOverWcId = null;
      lastCursorX = -1;
      lastCursorY = -1;
      return;
    }
    if (!win || win.isDestroyed()) return;
    let pt;
    try { pt = screen.getCursorScreenPoint(); } catch (_) { return; }
    const now = Date.now();
    let hit = null;
    for (const [wcId, r] of webviewBounds) {
      if (now - r.ts > 1500) { webviewBounds.delete(wcId); continue; }
      if (pt.x < r.x || pt.x >= r.x + r.w) continue;
      if (pt.y < r.y || pt.y >= r.y + r.h) continue;
      hit = wcId;
      break;
    }
    const justEntered = (hit !== cursorOverWcId);
    if (justEntered) {
      if (debug.enabled) {
        log('PULSE', hit === null ? 'cursor left' : ('cursor entered wc=' + hit));
      }
      cursorOverWcId = hit;
      lastCursorX = -1;
      lastCursorY = -1;
      lastMoveAt = 0;
    }
    if (hit === null) return;
    const moved = (pt.x !== lastCursorX || pt.y !== lastCursorY);
    if (moved) lastMoveAt = now;
    lastCursorX = pt.x;
    lastCursorY = pt.y;
    const withinGrace = (now - lastMoveAt) < CONTROL_PULSE_GRACE_MS;
    if (justEntered || moved || withinGrace) {
      pulseControls(hit);
      if (debug.enabled) {
        const why = justEntered ? 'enter' : (moved ? 'move' : 'keepalive');
        log('PULSE', 'sent wc=' + hit + ' jx=' + jitterPhase + ' ' + why);
      }
    }
  }, 100);
}
// ---------- End cursor-poll control-pulse ----------

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
      if (win && !win.isDestroyed()) {
        win.webContents.send('schedule-ready', { path: schedulePath });
      }
      return schedulePath;
    })
    .catch(err => {
      log('ERROR', 'Schedule regeneration failed: ' + err.message);
      return null;
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

        if (runtimeAllowedDomains.has(hostname)) {
          if (debug.enabled) {
            log('REQ', `test-allow ${(details.resourceType || 'unknown').padEnd(8)} ${hostname}`);
          }
          callback({ cancel: false });
          return;
        }

        let refHost = '';
        try { refHost = details.referrer ? new URL(details.referrer).hostname : ''; } catch (_) {}

        if (!blockedDomainsLogged.has(hostname)) {
          blockedDomainsLogged.add(hostname);
          const entry = `[AUTO-BLOCKED] ${hostname} ${details.resourceType} ${details.url.slice(0, 160)}`;
          log('BLOCK', `${(details.resourceType || 'unknown').padEnd(8)} ${hostname}${refHost ? '  ref=' + refHost : ''}`);
          writeSecurityLog(entry);
        }

        const prevBlock = blockedDomainRefs.get(hostname);
        blockedDomainRefs.set(hostname, {
          refHost,
          count: prevBlock ? prevBlock.count + 1 : 1,
          lastSeenMs: Date.now(),
          subFrame: (prevBlock && prevBlock.subFrame) || details.resourceType === 'subFrame'
        });

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

        if (isStreamingContent(details.url) && !details.url.includes('.pdf')) {
          const parityRef = headers['Referer'] || headers['referer'] || '';
          if (parityRef) {
            try { chainHosts.add(new URL(parityRef).hostname.toLowerCase()); } catch (_) {}
          }
          const streamKind = details.url.includes('.m3u8') ? 'm3u8' : 'segment';
          if (debug.enabled) {
            log('HDR', streamKind + ' req ' + truncateUrl(details.url, 130));
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

        if (debug.enabled && (details.resourceType === 'mainFrame' || details.resourceType === 'subFrame')) {
          log('HDR', `nav ${(details.resourceType || '').padEnd(8)} ${truncateUrl(details.url, 110)}`);
          log('HDR', `  wire-in UA=${(headers['User-Agent'] || headers['user-agent'] || '(none)')}`);
          log('HDR', `  wire-in Referer=${(headers['Referer'] || headers['referer'] || '(none)')}`);
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
          log('HDR', `  out Referer=${(headers['Referer'] || headers['referer'] || '(none)')} Origin=${(headers['Origin'] || headers['origin'] || '(none)')}`);
        }

        try {
          if (details.resourceType === 'subFrame') {
            chainHosts.add(new URL(details.url).hostname.toLowerCase());
          }
        } catch (_) {}

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
        hideUnmuteCurtain(details.webContentsId);
        warmUpPlayer(details.webContentsId);
        instrumentClicks(details.webContentsId);
        if (debug.enabled) probeTiestepFrame(details.webContentsId);
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

  win.once('ready-to-show', () => {
    win.show();
  });

  win.loadFile(targetPath).catch(err => {
    log('ERROR', 'Failed to load HTML file: ' + err.message);
  });
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

ipcMain.handle('get-recovery-candidates', () => {
  if (!debug.enabled) {
    return { enabled: false, candidates: [] };
  }
  const out = [];
  for (const [domain, info] of blockedDomainRefs) {
    if (Date.now() - info.lastSeenMs > 10 * 60 * 1000) continue;
    if (knownPassengers.has(domain)) continue;
    if (runtimeAllowedDomains.has(domain)) continue;
    if (activeConfig.safeDomains.some(d => domain === d || domain.endsWith('.' + d))) continue;
    const viaChainRef = chainHosts.has(info.refHost);
    const chainContext = viaChainRef || (info.subFrame && shellHosts.has(info.refHost));
    if (!chainContext) continue;
    const strong = ((info.subFrame && info.count >= 2) || info.count >= 8);
    const tag = viaChainRef ? (strong ? 'chain' : 'likely-ad') : 'chain?';
    out.push({ domain, refHost: info.refHost, count: info.count, tag, checked: viaChainRef && strong });
  }
  out.sort((a, b) => b.count - a.count);
  return { enabled: true, candidates: out.slice(0, 6) };
});

ipcMain.on('allow-recovery-domains', (event, payload) => {
  if (Array.isArray(payload)) {
    const added = [];
    for (const d of payload) {
      if (typeof d === 'string' && d) {
        runtimeAllowedDomains.add(d.toLowerCase());
        added.push(d.toLowerCase());
      }
    }
    if (added.length > 0) {
      log('CONFIG', 'Recovery test-allow: ' + added.join(', '));
    }
  }
});

ipcMain.on('recovery-test-result', (event, payload) => {
  if (!payload || !Array.isArray(payload.domains)) return;
  const domains = payload.domains.map(d => String(d).toLowerCase()).filter(Boolean);
  if (payload.passed === true) {
    if (pendingPromotion) clearTimeout(pendingPromotion.timer);
    log('CONFIG', 'Recovery test passed; promoting in 60s if playback stays stable: ' + domains.join(', '));
    pendingPromotion = {
      domains,
      timer: setTimeout(() => {
        pendingPromotion = null;
        const additions = loadAdditions();
        additions.safeDomains = Array.from(new Set([...additions.safeDomains, ...domains]));
        saveAdditions(additions);
        activeConfig.safeDomains = Array.from(new Set([...activeConfig.safeDomains, ...domains]));
        log('CONFIG', 'Promoted local addition(s) after 60s stable: ' + domains.join(', '));
        if (win && !win.isDestroyed()) {
          win.webContents.send('recovery-promoted', { domains });
        }
      }, 60000)
    };
  } else {
    if (pendingPromotion) {
      clearTimeout(pendingPromotion.timer);
      pendingPromotion = null;
      log('CONFIG', 'Recovery promotion cancelled — playback failed during soak');
    }
    if (domains.length === 1 && !knownPassengers.has(domains[0])) {
      const additions = loadAdditions();
      additions.passengers = Array.from(new Set([...additions.passengers, domains[0]]));
      saveAdditions(additions);
      knownPassengers.add(domains[0]);
      log('CONFIG', 'Recorded passenger (solo test failed): ' + domains[0]);
    }
  }
});

ipcMain.on('copy-text', (event, payload) => {
  if (typeof payload === 'string' && payload) {
    clipboard.writeText(payload);
  }
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

  const additions = loadAdditions();
  if (additions.safeDomains.length > 0) {
    activeConfig.safeDomains = Array.from(new Set([...activeConfig.safeDomains, ...additions.safeDomains]));
  }
  knownPassengers = new Set(additions.passengers);

  for (const u of activeConfig.baseStreamUrls) {
    try { shellHosts.add(new URL(u).hostname.toLowerCase()); } catch (_) {}
  }

  log('CONFIG', 'Active safeDomains: ' + activeConfig.safeDomains.join(', '));
  if (additions.safeDomains.length > 0) {
    log('CONFIG', 'Merged local addition(s): ' + additions.safeDomains.join(', '));
    log('CONFIG', 'Note: local additions are not in the gist — gist update is manual.');
  }
  if (debug.enabled) {
    log('DEBUG', 'Debug logging enabled (CHANNELSURFER_DEBUG=1 or --debug)');
    log('CONFIG', 'baseStreamUrls: ' + activeConfig.baseStreamUrls.join(' | '));
    if (additions.passengers.length > 0) {
      log('DEBUG', 'Known passengers (failed recovery tests): ' + additions.passengers.join(', '));
    }
  }

  protocol.registerFileProtocol('app', (request, callback) => {
    const url = request.url.substr(6);
    const imagePath = path.join(__dirname, 'images', url);
    callback({ path: imagePath });
  });

  createWindow();

  startCursorPoll();

  let scheduleRetryTimer = null;
  let appQuitting = false;

  app.on('before-quit', () => {
    appQuitting = true;
    if (scheduleRetryTimer) {
      clearTimeout(scheduleRetryTimer);
      scheduleRetryTimer = null;
    }
    try {
      const { abortActiveFetch } = require('./src/fetchEpg');
      abortActiveFetch();
    } catch (_) {}
  });

  (async () => {
    const retryDelayMs = 15000;
    while (!appQuitting) {
      const generated = await generateSchedule();
      if (generated || appQuitting) break;
      log('WARN', `Schedule unavailable; retrying in ${retryDelayMs / 1000}s`);
      await new Promise(resolve => {
        scheduleRetryTimer = setTimeout(() => {
          scheduleRetryTimer = null;
          resolve();
        }, retryDelayMs);
      });
    }
  })();

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