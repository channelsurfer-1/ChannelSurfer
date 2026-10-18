// ChannelSurfer connectivity probe — dev-only maintainer tool (10-17).
// Automated recovery-candidate tester: runs the app's REAL network
// machinery (default-deny blocker, curl-parity, UA triple, JW kick via the
// shared web-contents-created handler) against one hidden webview and
// reports the smallest set of blocked domains that must be added to the
// gist's safeDomains for the stream to play.
//
//   npm run probe               # default channel 51 (ABC USA), auto base
//   npm run probe -- --channel=664 --base=2
//
// Output: prints only. NEVER writes config-additions.json, latest-gist.json,
// or the gist — those code paths are unreachable from this entry point.
// Uses the real app's userData (read-only here); it never writes there either.
//
// Exit codes: 0 = healthy, nothing to do OR a minimal chain was found
//             (the chain is printed either way); 2 = no candidates at all
//             (upstream fault class, e.g. 10-16 dead CDN); 3 = candidates
//             exist but no subset connected; 1 = internal error.
//
// Success criterion: >= 4 successful media segments (.ts/.zst/.m4s, 2xx) on
// the probe guest. A 200 manifest alone is NOT success (10-16 buffer-loop
// class: 200-after-20s manifests, zero segment traffic).
//
// Algorithm:
//   PHASE 0  clean connect per base URL — if any plays, exit 0.
//   BASEPICK one exploratory attempt per base; pick the base with the
//            richest blocked-candidate harvest (the shell that gets
//            furthest into the player chain).
//   PHASE 1  widen-to-fixpoint on the picked base: attempt, harvest new
//            chain-context candidates, allow them, retry until an attempt
//            yields nothing new. If the full pool plays, it is a known-
//            working superset -> PHASE 2. If the full pool fails, no subset
//            can work -> exit 3.
//   PHASE 2  shrink-to-minimal: full reset between trials; subsets in
//            ascending size (discovery/chain order); first pass wins.
//   Every trial resets ALL recovery state (09-27 lesson: stale allow-sets
//   and stale passengers hide the real chain answer).

process.env.CHANNELSURFER_PROBE = '1'; // must precede the main.js require: skips its boot block
process.env.CHANNELSURFER_DEBUG = '1'; // must precede the src/debug require: full [REQ]/[BLOCK] logging

const { app, session, BrowserWindow } = require('electron');
const path = require('path');
const main = require('./main'); // machinery only; boot block skipped via CHANNELSURFER_PROBE

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';

const ATTEMPT_TIMEOUT_MS = 60000;
const SUCCESS_SEGMENTS = 4;
const PHASE1_MAX_ITERS = 8;
const PHASE2_MAX_TRIALS = 25;
const PHASE2_MAX_SIZE = 3; // singles, pairs, triples (JW chain was 3)

const argv = process.argv.slice(1);
function argVal(name, dflt) {
  const a = argv.find(x => x.startsWith('--' + name + '='));
  return a ? a.split('=').slice(1).join('=') : dflt;
}
const channelId = String(argVal('channel', '51')).replace(/\D/g, '') || '51';
const baseArg = argVal('base', null);

let win = null;
let bases = [];

function probeLog(what, msg) {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  console.log(`[${hh}:${mm}:${ss}] [PROBE ] ${what}: ${msg}`);
}

// Guest console capture (probe v1.1, 10-17): hls.js/JW errors never reach
// the webRequest log — they go to the guest console. Without this, the
// "playlist reloads forever, no segments fetched" class is undiagnosable.
// Covers every webview guest this run creates.
app.on('web-contents-created', (event, contents) => {
  if (contents.getType() !== 'webview') return;
  // The probe is a diagnostic tool, not a viewing experience: silence every
  // guest. Playback detection is player-truth (currentTime/readyState),
  // which is mute-independent. Without this the shared curtain path unmutes
  // each trial guest and the probe blasts audio for the whole run.
  try { contents.setAudioMuted(true); } catch (_) {}
  let lastMsg = '';
  contents.on('console-message', (e, level, message) => {
    const m = String(message || '');
    if (m.includes('[CS-CLICK]')) return; // click-probe noise
    if (m === lastMsg) return;            // burst dedup
    lastMsg = m;
    probeLog('guest', 'L' + level + ' ' + m.slice(0, 220));
  });
});

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function combos(arr, size) {
  const out = [];
  const rec = (start, acc) => {
    if (acc.length === size) { out.push(acc.slice()); return; }
    for (let i = start; i < arr.length; i++) {
      acc.push(arr[i]); rec(i + 1, acc); acc.pop();
    }
  };
  rec(0, []);
  return out;
}

function finish(code, msg) {
  console.log(`[PROBE ] ${msg}`);
  console.log(`[PROBE ] EXIT code=${code}`);
  setTimeout(() => process.exit(code), 500);
}

// Create one guest webview in the hidden window; resolves with its webContents.
function createGuest(url) {
  return new Promise((resolve, reject) => {
    const onCreated = (e, contents) => {
      if (contents.getType() !== 'webview') return;
      app.off('web-contents-created', onCreated);
      resolve(contents);
    };
    app.on('web-contents-created', onCreated);
    win.webContents.executeJavaScript(`(function() {
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

// Read the <video> element's real playback state from the guest's player
// frame (same probe as the app's health poll). Returns null when the frame
// or element is not there yet — the poll loop treats null as "not yet".
async function readPlayerState(wc) {
  if (!wc || wc.isDestroyed()) return null;
  const f = main.findPlayerFrame(wc);
  if (!f) return null;
  try {
    return await f.executeJavaScript(
      `(function(){var v=document.querySelector('video');if(!v)return null;` +
      `return {t:v.currentTime,rs:v.readyState,paused:!!v.paused};})()`, true);
  } catch (_) { return null; }
}

// One full-fidelity connect attempt. allowList domains are runtime-allowed;
// everything else goes through the production default-deny pipeline.
// Returns { ok, harvest } where harvest is this attempt's chain-context
// blocked candidates (computeRecoveryCandidates already excludes the
// allowed set and gist-safe domains).
async function attemptConnect(baseIndex, allowList) {
  main.resetRecoveryState();
  for (const d of allowList) main.runtimeAllowedDomains.add(d);
  try { await session.defaultSession.clearCache(); } catch (_) {}

  const url = bases[baseIndex] + channelId + '.php';
  probeLog('attempt', `base=${baseIndex} url=${url} allowed=[${allowList.join(', ')}]`);

  const wc = await createGuest(url);
  const id = wc.id;
  main.trackedStreamWebviews.add(id);

  // Success = PLAYER TRUTH, not URL shape (v1.2, 10-17): the site serves
  // segments as extensionless signed URLs (pXX-common-sign.tiktokcdn-us.com
  // .image template), so counting .ts/.m4s/.zst URLs false-negatives on a
  // perfectly healthy stream. Read the video element in the player frame:
  // readyState >= 2 (HAVE_CURRENT_DATA) and currentTime advancing between
  // polls is proof of real playback. segmentHits stays as a log-only hint.
  const t0 = Date.now();
  let lastT = null;
  let ok = false;
  let lastState = null;
  while (Date.now() - t0 < ATTEMPT_TIMEOUT_MS) {
    await sleep(2000);
    const st = await readPlayerState(wc);
    lastState = st;
    if (st && st.rs >= 2 && typeof st.t === 'number') {
      if (lastT !== null && st.t > lastT + 0.5) { ok = true; break; }
      lastT = st.t;
    } else {
      lastT = null;
    }
    if (wc.isDestroyed()) break;
  }
  const segments = main.segmentHits.get(id) || 0;
  const harvest = main.computeRecoveryCandidates();

  main.trackedStreamWebviews.delete(id);
  try { wc.destroy(); } catch (_) {}
  try {
    await win.webContents.executeJavaScript(
      `document.querySelectorAll('webview').forEach(w => w.remove()); true`);
  } catch (_) {}

  const ps = lastState ? `rs=${lastState.rs} t=${typeof lastState.t === 'number' ? lastState.t.toFixed(1) : '?'}` : 'no-video';
  probeLog('attempt', `-> ${ok ? 'CONNECT-OK' : 'FAIL'} player ${ps} segHits=${segments} new-candidates=[${harvest.map(c => c.domain).join(', ')}]`);
  return { ok, harvest };
}

app.whenReady().then(async () => {
  session.defaultSession.setUserAgent(UA);

  const config = await main.loadConfig();
  const additions = main.loadAdditions();
  main.setActiveConfig({
    ...config,
    safeDomains: main.mergeSafeDomains(config.safeDomains, additions.safeDomains)
  });
  main.installRequestHandlers();
  main.resetRecoveryState();

  bases = config.baseStreamUrls;
  let baseIdx = 0;
  if (baseArg !== null) {
    const b = parseInt(baseArg, 10);
    if (isNaN(b) || b < 0 || b >= bases.length) {
      finish(1, `FATAL --base=${baseArg} out of range (0..${bases.length - 1})`);
      return;
    }
    baseIdx = b;
  }
  probeLog('start', `channel=${channelId} bases=${bases.length} base=${baseIdx} (${baseArg !== null ? 'fixed' : 'auto'}) safeDomains=${config.safeDomains.length} (+${additions.safeDomains.length} local additions)`);

  win = new BrowserWindow({
    title: 'ChannelSurfer probe',
    width: 960,
    height: 540,
    show: false,
    backgroundColor: '#111111',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      webviewTag: true
    }
  });
  await win.loadFile(path.join(__dirname, 'probe.html'));

  // ---- PHASE 0: clean connect per base — healthy path ----
  let healthyBase = -1;
  for (let i = 0; i < bases.length; i++) {
    const r = await attemptConnect(i, []);
    if (r.ok) { healthyBase = i; break; }
  }
  if (healthyBase >= 0) {
    finish(0, `HEALTHY — connected clean on base ${healthyBase}; nothing to do`);
    return;
  }
  probeLog('phase0', 'no base connected clean; entering candidate discovery');

  // ---- BASE PICK (auto): one exploratory attempt per base, richest harvest wins ----
  if (baseArg === null) {
    let best = -1;
    let bestCount = -1;
    for (let i = 0; i < bases.length; i++) {
      const r = await attemptConnect(i, []);
      const n = r.harvest.length;
      if (n > bestCount) { bestCount = n; best = i; }
    }
    baseIdx = best;
    probeLog('basepick', `base=${baseIdx} (harvest ${bestCount} candidate(s))`);
  }

  // ---- PHASE 1: widen to fixpoint ----
  const pool = []; // discovery order ~ chain order
  let supersetOk = false;
  for (let iter = 0; iter < PHASE1_MAX_ITERS; iter++) {
    const r = await attemptConnect(baseIdx, pool);
    if (r.ok) { supersetOk = true; break; }
    const fresh = r.harvest.filter(c => !pool.includes(c.domain));
    if (fresh.length === 0) break; // fixpoint: nothing new to allow
    for (const c of fresh) pool.push(c.domain);
    probeLog('phase1', `iter=${iter} pool=[${pool.join(', ')}]`);
  }

  if (!supersetOk) {
    if (pool.length === 0) {
      finish(2, 'UPSTREAM-FAULT? — zero candidates harvested; nothing was blocked that the app could allow. If the log shows [RESP] 404s on edge m3u8s, the CDN content is gone (10-16 class) — wait, re-pick, or gist-level fix.');
      return;
    }
    finish(3, `NO-CONNECT — full pool [${pool.join(', ')}] still fails; no subset can work. Check [RESP] lines: 404s on edge m3u8 = upstream dead; anything else, re-run with --base to test another shell.`);
    return;
  }
  probeLog('phase1', `pool plays: [${pool.join(', ')}] — minimizing`);

  // ---- PHASE 2: shrink to minimal ----
  let found = null;
  let trials = 0;
  outer:
  for (let size = 1; size <= Math.min(PHASE2_MAX_SIZE, pool.length); size++) {
    for (const combo of combos(pool, size)) {
      if (++trials > PHASE2_MAX_TRIALS) break outer;
      const r = await attemptConnect(baseIdx, combo);
      if (r.ok) { found = combo; break outer; }
    }
  }

  if (found) {
    finish(0, `RESULT chain=${found.join(', ')} | ACTION: add to gist safeDomains (manual paste): ${found.join(', ')}`);
  } else {
    finish(3, `NO-SUBSET — no combination of size <= ${PHASE2_MAX_SIZE} from pool [${pool.join(', ')}] connected within ${PHASE2_MAX_TRIALS} trials. Pool may be incomplete (deeper chain) or upstream sick.`);
  }
}).catch((err) => {
  console.error('[PROBE ] FATAL', err && err.stack ? err.stack : err);
  process.exit(1);
});
