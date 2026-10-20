// ChannelSurfer auto-add — silent in-app self-healing for site rotation (10-20).
// When the renderer reports a genuinely exhausted failover cycle
// ('failover-exhausted'), auto-add runs the app's own connect machinery in a
// hidden guest against the failing channel. If the allow-pool needs new
// domains, it finds them with the probe's harvest machinery and commits them
// ONLY on behavioral evidence — the setup driver's commit-on-success
// discipline (§8.q), never the probe's speculative widening. On success the
// pane re-streams automatically; the user sees nothing but the stream coming
// back. On failure the channel is classified (usually upstream-dead) and a
// cooldown silences re-runs.
//
// Invariants: one run app-wide at a time; ~10 min cooldown after every run;
// hidden guest, audio-muted; gentle teardown (untrack -> detach -> settle —
// the 10-19 SEGV lesson); nothing user-visible; [AUTOADD] lines ride the
// debug chokepoint (rule 7 — clean mode stays clean).

'use strict';

const { app, session, BrowserWindow } = require('electron');
const path = require('path');

const AUTOADD_COOLDOWN_MS = 10 * 60 * 1000;
const ATTEMPT_TIMEOUT_MS = 15000;
const RETRY_TIMEOUT_MS = 60000;   // one long retry before declaring dead (slow-CDN class)
const POLL_MS = 1000;
const ADVANCE_THRESHOLD = 0.5;    // seconds of currentTime gain between polls = playing
const SETTLE_MS = 700;            // guest-teardown settle before the next create

let deps = null;
let running = false;
let hiddenWin = null;
let lastRunEnd = 0;

function alog(msg) {
  if (deps && deps.debugEnabled && deps.debugEnabled()) deps.log('AUTOADD', msg);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function readPlayerState(wc) {
  if (!wc || wc.isDestroyed()) return null;
  const f = deps.findPlayerFrame(wc);
  if (!f) return null;
  try {
    return await f.executeJavaScript(
      `(function(){var v=document.querySelector('video');if(!v)return null;` +
      `return {t:v.currentTime,rs:v.readyState,paused:!!v.paused};})()`, true);
  } catch (_) { return null; }
}

// One full-fidelity connect attempt — a mirror of setup-main.js v1.1
// attemptConnect (same gentle teardown). allowList domains are
// runtime-allowed; everything else rides the production default-deny
// pipeline. Player-truth success.
async function attemptConnect(channelId, baseIndex, allowList, timeoutMs) {
  deps.resetRecoveryState();
  for (const d of allowList) deps.runtimeAllowedDomains.add(d);
  try { await session.defaultSession.clearCache(); } catch (_) {}

  const bases = deps.getActiveConfig().baseStreamUrls;
  const url = bases[baseIndex] + channelId + '.php';
  alog('attempt ch=' + channelId + ' base=' + baseIndex + ' timeout=' + (timeoutMs / 1000) + 's allowed=' + allowList.length);

  const wc = await createGuest(url);
  const id = wc.id;
  deps.trackedStreamWebviews.add(id);

  const t0 = Date.now();
  let lastT = null;
  let ok = false;
  let lastState = null;
  while (Date.now() - t0 < timeoutMs) {
    await sleep(POLL_MS);
    const st = await readPlayerState(wc);
    lastState = st;
    if (st && st.rs >= 2 && typeof st.t === 'number') {
      if (lastT !== null && st.t > lastT + ADVANCE_THRESHOLD) { ok = true; break; }
      lastT = st.t;
    } else {
      lastT = null;
    }
    if (wc.isDestroyed()) break;
  }
  const segments = deps.segmentHits.get(id) || 0;
  const harvest = deps.computeRecoveryCandidates();

  // Gentle teardown (untrack -> detach -> settle). Never wc.destroy().
  deps.trackedStreamWebviews.delete(id);
  try {
    await hiddenWin.webContents.executeJavaScript(
      `document.querySelectorAll('webview').forEach(w => w.remove()); true`);
  } catch (_) {}
  await sleep(SETTLE_MS);

  const ps = lastState
    ? 'rs=' + lastState.rs + ' t=' + (typeof lastState.t === 'number' ? lastState.t.toFixed(1) : '?')
    : 'no-video';
  alog('attempt -> ' + (ok ? 'CONNECT-OK' : 'FAIL') + ' ch=' + channelId + ' ' + ps + ' segHits=' + segments);
  return { ok, harvest, lastState };
}

function createGuest(url) {
  return new Promise((resolve, reject) => {
    const onCreated = (e, contents) => {
      if (contents.getType() !== 'webview') return;
      app.off('web-contents-created', onCreated);
      try { contents.setAudioMuted(true); } catch (_) {}
      resolve(contents);
    };
    app.on('web-contents-created', onCreated);
    hiddenWin.webContents.executeJavaScript(`(function() {
      const w = document.createElement('webview');
      w.setAttribute('allowfullscreen', 'true');
      w.setAttribute('webpreferences', 'webSecurity=no');
      w.style.width = '640px';
      w.style.height = '360px';
      w.src = ${JSON.stringify(url)};
      document.body.appendChild(w);
      return true;
    })()`).catch((err) => {
      app.off('web-contents-created', onCreated);
      reject(err);
    });
  });
}

async function ensureHiddenWin() {
  if (hiddenWin && !hiddenWin.isDestroyed()) return;
  hiddenWin = new BrowserWindow({
    title: 'ChannelSurfer auto-add',
    width: 960,
    height: 540,
    show: false,
    backgroundColor: '#111111',
    webPreferences: { nodeIntegration: false, contextIsolation: true, webviewTag: true }
  });
  await hiddenWin.loadFile(path.join(__dirname, '..', 'probe.html'));
}

async function teardownHiddenWin() {
  try {
    if (hiddenWin && !hiddenWin.isDestroyed()) {
      await hiddenWin.webContents.executeJavaScript(
        `document.querySelectorAll('webview').forEach(w => w.remove()); true`);
      await sleep(SETTLE_MS);
      hiddenWin.destroy();
    }
  } catch (_) {}
  hiddenWin = null;
}

function finishRun(channelId, committed, recovered, lastState, rejected) {
  if (recovered) {
    alog('ch=' + channelId + ' recovered' + (committed.length ? ', committed: ' + committed.join(', ') : ' (transient)') + ' — re-streaming pane');
    const w = deps.getWin();
    if (w && !w.isDestroyed()) {
      w.webContents.send('autoadd-recovered', { dlhdId: channelId, domains: committed });
    }
    return;
  }
  const ps = lastState
    ? 'rs=' + lastState.rs + ' t=' + (typeof lastState.t === 'number' ? lastState.t.toFixed(1) : '?')
    : 'no-video';
  alog('ch=' + channelId + ' classified DEAD ' + ps + ' rejected=[' + (rejected || []).join(', ') + '] — upstream class, nothing committed');
}

async function runAutoAdd(channelId) {
  if (running) { alog('ch=' + channelId + ' skipped — run already in flight'); return; }
  if (Date.now() - lastRunEnd < AUTOADD_COOLDOWN_MS) { alog('ch=' + channelId + ' skipped — cooldown'); return; }
  if (!deps.getWin() || deps.getWin().isDestroyed()) return;
  running = true;
  alog('run start ch=' + channelId);
  let committed = [];
  let recovered = false;
  let lastState = null;
  let rejected = [];
  try {
    await ensureHiddenWin();
    const bases = deps.getActiveConfig().baseStreamUrls;
    const pool = deps.getActiveConfig().safeDomains.slice();

    let mergedHarvest = [];
    let bestBase = 0;
    let bestCount = -1;
    for (let b = 0; b < bases.length; b++) {
      const r = await attemptConnect(channelId, b, pool, ATTEMPT_TIMEOUT_MS);
      lastState = r.lastState;
      for (const c of r.harvest) {
        if (!mergedHarvest.includes(c.domain)) mergedHarvest.push(c.domain);
      }
      if (r.harvest.length > bestCount) { bestCount = r.harvest.length; bestBase = b; }
      if (r.ok) { recovered = true; break; }
    }

    if (!recovered) {
      // Tentative widen (commit-on-success): a failure's harvest is mostly
      // ad noise; the additions only survive if the widened attempt plays.
      const fresh = mergedHarvest.filter(d => !pool.includes(d));
      rejected = fresh;
      if (fresh.length > 0) {
        alog('trial widen (uncommitted): ' + fresh.join(', '));
        const r2 = await attemptConnect(channelId, bestBase, pool.concat(fresh), ATTEMPT_TIMEOUT_MS);
        lastState = r2.lastState || lastState;
        if (r2.ok) { recovered = true; committed = fresh; }
      }
      if (!recovered) {
        const r3 = await attemptConnect(channelId, bestBase, deps.getActiveConfig().safeDomains.slice(), RETRY_TIMEOUT_MS);
        lastState = r3.lastState || lastState;
        if (r3.ok) { recovered = true; } // slow-CDN class; committed stays empty
      }
    }

    if (recovered && committed.length > 0) {
      deps.commitRecoveryDomains(committed); // write-on-pass + 60s soak + rollback (shared with the dialog)
    }
    finishRun(channelId, committed, recovered, lastState, rejected);
  } catch (err) {
    alog('run error ch=' + channelId + ': ' + (err && err.message ? err.message : err));
  } finally {
    running = false;
    lastRunEnd = Date.now();
    await teardownHiddenWin();
    alog('run end ch=' + channelId);
  }
}

module.exports = {
  init(d) { deps = d; },
  run(channelId) {
    runAutoAdd(channelId).catch((err) => {
      running = false;
      lastRunEnd = Date.now();
      try { deps && deps.log('AUTOADD', 'fatal: ' + (err && err.message ? err.message : err)); } catch (_) {}
      teardownHiddenWin();
    });
  }
};