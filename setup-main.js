// ChannelSurfer setup driver — dev-only proof-of-concept (10-19, v1.1).
// Batch-initializes a local safeDomains config: loops the station list in
// data/final_channel_mapping.json through the app's REAL connect machinery
// (same seam the probe uses; CHANNELSURFER_PROBE=1 skips the app boot) and
// writes a gist-shaped starting config the app could load in place of the
// remote gist.
//
//   npm run setup                    # full run, checkpointed
//   npm run setup -- --limit=5       # smoke-test first N stations
//   npm run setup -- --resume        # continue from checkpoint
//   npm run setup -- --fresh         # ignore checkpoint, start over
//   npm run setup -- --channel=51    # single station (always re-tests)
//
// Output: data/setup-checkpoint.json (resume state), data/setup-config.json
// (gist-shaped result), console health report. NEVER writes userData (same
// read-only discipline as the probe); NEVER touches the gist.
//
// Exit codes: 0 = completed; 2 = early-stop (site-wide condition, the 10-16
// consecutive-identical-failure signature); 1 = internal error.
//
// Design:
//   - Chains are app-wide (player build + CDN infra shared across channels),
//     so the run keeps ONE global allow-pool, grown monotonically by
//     per-station harvests. The minimal-chain shrink runs ONCE at the end,
//     over domains NEW this run, in the context of the pre-existing pool
//     (rule 4: proven gist domains are never pruned without a
//     failure-state repro — full-pool shrink is out of scope here).
//   - WIDEN IS TENTATIVE (v1.1): a failed station's harvest is committed to
//     the pool ONLY if the widened attempt then plays. The v1.0 run showed
//     a DEAD station's ad-noise harvest permanently poisoning newDomains —
//     the 09-27 poisoning lesson in a new place. Nothing enters the
//     allow-list without behavioral evidence.
//   - Success = PLAYER TRUTH (readyState >= 2 + advancing currentTime),
//     never URL shape (10-17 lesson: extensionless segment URLs).
//   - Two-tier timeout: 15s per attempt; a station that fails clean gets
//     ONE 60s retry before DEAD (10-16 slow-CDN insurance).
//   - Early stop: 5 consecutive station failures with zero pool growth ->
//     site-wide classification, checkpoint, exit 2.
//   - Guest teardown is gentle (v1.1): untrack from main-side polls, detach
//     the element, let the embedder destroy the guest, settle 700ms before
//     the next create. The v1.0 run SEGV'd (near-null deref on the main
//     thread in the timer path, 0.6s after a rapid destroy/create cycle) —
//     consistent with a native guest-lifecycle race from wc.destroy().

process.env.CHANNELSURFER_PROBE = '1'; // must precede the main.js require: skips its boot block
process.env.CHANNELSURFER_DEBUG = '1'; // must precede the src/debug require: full [REQ]/[BLOCK] logging

const { app, session, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const main = require('./main'); // machinery only; boot block skipped via CHANNELSURFER_PROBE

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';

const ATTEMPT_TIMEOUT_MS = 15000;
const RETRY_TIMEOUT_MS = 60000;   // one long retry per dead station (slow-CDN class)
const POLL_MS = 1000;             // finer currentTime sampling inside the short window
const ADVANCE_THRESHOLD = 0.5;    // seconds of currentTime gain between polls = playing
const SETTLE_MS = 700;            // guest-teardown settle before next create (SEGV mitigation)
const EARLY_STOP_WINDOW = 5;      // consecutive no-growth failures -> site-wide stop
const SHRINK_MAX_TRIALS = 10;     // phase-2 cap for the global minimal pass

const MAPPING_PATH = path.join(__dirname, 'data', 'final_channel_mapping.json');
const CHECKPOINT_PATH = path.join(__dirname, 'data', 'setup-checkpoint.json');
const OUTPUT_PATH = path.join(__dirname, 'data', 'setup-config.json');

const argv = process.argv.slice(1);
function argVal(name, dflt) {
  const a = argv.find(x => x.startsWith('--' + name + '='));
  return a ? a.split('=').slice(1).join('=') : dflt;
}
const singleChannel = argv.some(x => x.startsWith('--channel='))
  ? String(argVal('channel', '51')).replace(/\D/g, '') || '51' : null;
const limitArg = argVal('limit', null);
const fixedBaseArg = argVal('base', null);
const wantResume = argv.includes('--resume');
const wantFresh = argv.includes('--fresh');

let win = null;
let bases = [];
let initialDomains = [];   // gist + local additions (proven, never pruned here)
let newDomains = [];       // domains COMMITTED by this run (shrink candidates)
let consecutiveNoGrowthFails = 0;
let earlyStopped = false;

function setupLog(what, msg) {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  console.log(`[${hh}:${mm}:${ss}] [SETUP ] ${what}: ${msg}`);
}

// Guest console capture (same rationale as the probe, 10-17): hls.js/JW
// errors live only in the guest console. Every guest this run creates is
// audio-muted — playback detection is player-truth, which is mute-independent.
app.on('web-contents-created', (event, contents) => {
  if (contents.getType() !== 'webview') return;
  try { contents.setAudioMuted(true); } catch (_) {}
  let lastMsg = '';
  contents.on('console-message', (e, level, message) => {
    const m = String(message || '');
    if (m.includes('[CS-CLICK]')) return;
    if (m === lastMsg) return;
    lastMsg = m;
    setupLog('guest', 'L' + level + ' ' + m.slice(0, 220));
  });
});

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Atomic write (09-18 schedule-hardening pattern): tmp + rename.
function writeJsonAtomic(file, obj) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

function finish(code, msg) {
  console.log(`[SETUP ] ${msg}`);
  console.log(`[SETUP ] EXIT code=${code}`);
  setTimeout(() => process.exit(code), 500);
}

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

// One full-fidelity connect attempt against one station. allowList domains
// are runtime-allowed; everything else rides the production default-deny
// pipeline. Player-truth success (readyState >= 2 + currentTime advancing).
async function attemptConnect(channelId, baseIndex, allowList, timeoutMs) {
  main.resetRecoveryState();
  for (const d of allowList) main.runtimeAllowedDomains.add(d);
  try { await session.defaultSession.clearCache(); } catch (_) {}

  const url = bases[baseIndex] + channelId + '.php';
  setupLog('attempt', `ch=${channelId} base=${baseIndex} timeout=${timeoutMs / 1000}s allowed=${allowList.length}`);

  const wc = await createGuest(url);
  const id = wc.id;
  main.trackedStreamWebviews.add(id);

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
  const segments = main.segmentHits.get(id) || 0;
  const harvest = main.computeRecoveryCandidates();

  // Gentle teardown (v1.1, SEGV mitigation): untrack FIRST so main-side
  // cursor/health polls drop this guest; detach the element and let the
  // embedder destroy the guest naturally (no wc.destroy()); settle before
  // the caller may create the next guest.
  main.trackedStreamWebviews.delete(id);
  try {
    await win.webContents.executeJavaScript(
      `document.querySelectorAll('webview').forEach(w => w.remove()); true`);
  } catch (_) {}
  await sleep(SETTLE_MS);

  const ms = Date.now() - t0;
  const ps = lastState
    ? `rs=${lastState.rs} t=${typeof lastState.t === 'number' ? lastState.t.toFixed(1) : '?'}`
    : 'no-video';
  setupLog('attempt', `-> ${ok ? 'CONNECT-OK' : 'FAIL'} ch=${channelId} ${ps} segHits=${segments} new-candidates=[${harvest.map(c => c.domain).join(', ')}] (${ms}ms)`);
  return { ok, harvest, ms, lastState };
}

// Global pool = proven initial domains + this run's committed additions.
function currentPool() { return initialDomains.concat(newDomains); }

// One station through the full state machine. Returns the checkpoint record.
async function runStation(chId, name) {
  const pool = currentPool();
  let lastState = null;
  let mergedHarvest = [];
  let bestBase = fixedBaseArg !== null ? parseInt(fixedBaseArg, 10) : 0;
  let bestCount = -1;
  let playedBase = -1;

  // Pass 1: one attempt per base with the current global pool; track the
  // richest harvest base (probe's basepick) in case widening is needed.
  const baseOrder = fixedBaseArg !== null
    ? [parseInt(fixedBaseArg, 10)]
    : bases.map((_, i) => i);
  for (const b of baseOrder) {
    const r = await attemptConnect(chId, b, pool, ATTEMPT_TIMEOUT_MS);
    lastState = r.lastState;
    for (const c of r.harvest) {
      if (!mergedHarvest.includes(c.domain)) mergedHarvest.push(c.domain);
    }
    if (r.harvest.length > bestCount) { bestCount = r.harvest.length; bestBase = b; }
    if (r.ok) { playedBase = b; break; }
  }

  if (playedBase >= 0) {
    consecutiveNoGrowthFails = 0;
    return { name, status: 'OK', base: playedBase, ts: Date.now() };
  }

  // Pass 2: widen TENTATIVELY. Commit only if the widened attempt plays
  // (rule 4: behavioral evidence). The v1.0 run committed a dead station's
  // ad-noise harvest permanently — never again.
  const fresh = mergedHarvest.filter(d => !pool.includes(d));
  if (fresh.length > 0) {
    setupLog('widen', `ch=${chId} trial += [${fresh.join(', ')}] (uncommitted)`);
    const r2 = await attemptConnect(chId, bestBase, pool.concat(fresh), ATTEMPT_TIMEOUT_MS);
    lastState = r2.lastState;
    if (r2.ok) {
      for (const d of fresh) newDomains.push(d);
      consecutiveNoGrowthFails = 0;
      return { name, status: 'RECOVERED', base: bestBase, added: fresh, ts: Date.now() };
    }
  }

  // Pass 3: the 60s slow-CDN retry against the COMMITTED pool only.
  const r3 = await attemptConnect(chId, bestBase, currentPool(), RETRY_TIMEOUT_MS);
  lastState = r3.lastState;
  if (r3.ok) {
    consecutiveNoGrowthFails = 0;
    return { name, status: 'RECOVERED', base: bestBase, added: [], slow: true, ts: Date.now() };
  }

  consecutiveNoGrowthFails++;
  const ps = lastState
    ? `rs=${lastState.rs} t=${typeof lastState.t === 'number' ? lastState.t.toFixed(1) : '?'}`
    : 'no-video';
  return { name, status: 'DEAD', base: bestBase, player: ps, rejected: fresh, ts: Date.now() };
}

app.whenReady().then(async () => {
  session.defaultSession.setUserAgent(UA);

  const config = await main.loadConfig();
  const additions = main.loadAdditions();
  initialDomains = main.mergeSafeDomains(config.safeDomains, additions.safeDomains);
  // Prune-audit support (10-20): --exclude=a,b,c drops domains from the
  // initial pool so a healthy-day run can test whether they're load-bearing
  // (§6 item 9 evidence-gate, bulk form).
  const excludeArg = argVal('exclude', null);
  const excludeSet = new Set(excludeArg ? excludeArg.split(',').map(d => d.trim().toLowerCase()).filter(Boolean) : []);
  if (excludeSet.size > 0) {
    const before = initialDomains.length;
    initialDomains = initialDomains.filter(d => !excludeSet.has(d));
    setupLog('audit', 'excluded ' + (before - initialDomains.length) + ' domain(s), pool ' + before + ' -> ' + initialDomains.length + ': ' + initialDomains.join(', '));
  }
  main.setActiveConfig({ ...config, safeDomains: initialDomains.slice() });
  main.installRequestHandlers();
  main.resetRecoveryState();

  bases = config.baseStreamUrls;
  setupLog('start', `stations-file=${MAPPING_PATH} bases=${bases.length} initial-pool=${initialDomains.length}`);

  const mapping = JSON.parse(fs.readFileSync(MAPPING_PATH, 'utf8'));
  const allIds = Object.keys(mapping);

  // Checkpoint: load unless --fresh; single-station mode bypasses recorded
  // statuses (it always re-tests) but still updates the file.
  let checkpoint = { version: 1, started: Date.now(), stations: {}, newDomains: [] };
  if (!wantFresh && fs.existsSync(CHECKPOINT_PATH)) {
    try {
      checkpoint = JSON.parse(fs.readFileSync(CHECKPOINT_PATH, 'utf8'));
      newDomains = (checkpoint.newDomains || []).filter(d => !initialDomains.includes(d));
      setupLog('resume', `checkpoint ${new Date(checkpoint.updated || checkpoint.started).toISOString()} stations-recorded=${Object.keys(checkpoint.stations).length} pool-additions=${newDomains.length}`);
    } catch (err) {
      setupLog('resume', `checkpoint unreadable (${err.message}); starting fresh`);
      checkpoint = { version: 1, started: Date.now(), stations: {}, newDomains: [] };
    }
  }

  let todo = allIds;
  if (singleChannel) {
    todo = allIds.includes(singleChannel) ? [singleChannel] : [];
    if (todo.length === 0) { finish(1, `FATAL --channel=${singleChannel} not in station file`); return; }
  } else if (wantResume) {
    todo = allIds.filter(id => !checkpoint.stations[id]);
  }
  if (limitArg !== null) {
    const n = parseInt(limitArg, 10);
    if (!isNaN(n) && n > 0) todo = todo.slice(0, n);
  }
  setupLog('plan', `${todo.length} station(s) to test${singleChannel ? ' (single)' : ''}${wantResume ? ' (resume)' : ''}`);

  win = new BrowserWindow({
    title: 'ChannelSurfer setup',
    width: 960,
    height: 540,
    show: false,
    backgroundColor: '#111111',
    webPreferences: { nodeIntegration: false, contextIsolation: true, webviewTag: true }
  });
  await win.loadFile(path.join(__dirname, 'probe.html'));

  const counts = { OK: 0, RECOVERED: 0, DEAD: 0 };
  for (const chId of todo) {
    const name = mapping[chId] ? mapping[chId].dlhd_name : '?';
    const rec = await runStation(chId, name);
    counts[rec.status] = (counts[rec.status] || 0) + 1;
    checkpoint.stations[chId] = rec;
    checkpoint.newDomains = newDomains.slice();
    checkpoint.updated = Date.now();
    writeJsonAtomic(CHECKPOINT_PATH, checkpoint);

    if (rec.status === 'OK') {
      setupLog('station', `OK       ${chId} "${name}" base=${rec.base}`);
    } else if (rec.status === 'RECOVERED') {
      setupLog('station', `RECOVERED ${chId} "${name}" base=${rec.base} new=[${(rec.added || []).join(', ')}]${rec.slow ? ' (slow-connect)' : ''}`);
    } else {
      setupLog('station', `DEAD     ${chId} "${name}" ${rec.player} rejected=[${(rec.rejected || []).join(', ')}] (upstream class? see [RESP] lines)`);
    }

    if (!singleChannel && consecutiveNoGrowthFails >= EARLY_STOP_WINDOW) {
      earlyStopped = true;
      setupLog('early-stop', `${EARLY_STOP_WINDOW} consecutive failures with zero pool growth — site-wide condition (10-16 signature). Stopping; re-run later with --resume.`);
      break;
    }
  }

  // ---- Global shrink pass (once, over NEW domains only, in context) ----
  let finalPool = currentPool();
  if (!earlyStopped && newDomains.length > 0) {
    const testId = Object.keys(checkpoint.stations)
      .find(id => (checkpoint.stations[id].added || []).length > 0);
    if (testId) {
      const testBase = checkpoint.stations[testId].base || 0;
      let trials = 0;
      let found = null;
      outer:
      for (let size = 1; size <= newDomains.length; size++) {
        const combos = [];
        const rec = (start, acc) => {
          if (acc.length === size) { combos.push(acc.slice()); return; }
          for (let i = start; i < newDomains.length; i++) {
            acc.push(newDomains[i]); rec(i + 1, acc); acc.pop();
          }
        };
        rec(0, []);
        for (const combo of combos) {
          if (++trials > SHRINK_MAX_TRIALS) break outer;
          const r = await attemptConnect(testId, testBase,
            initialDomains.concat(combo), ATTEMPT_TIMEOUT_MS);
          if (r.ok) { found = combo; break outer; }
        }
      }
      if (found) {
        setupLog('shrink', `minimal new-chain = [${found.join(', ')}] (was [${newDomains.join(', ')}])`);
        finalPool = initialDomains.concat(found);
      } else {
        setupLog('shrink', `no subset connected within ${SHRINK_MAX_TRIALS} trials; keeping full new set [${newDomains.join(', ')}]`);
      }
    }
  }

  writeJsonAtomic(OUTPUT_PATH, {
    safeDomains: finalPool,
    baseStreamUrls: bases
  });

  // Authority flip (16b): the setup driver is the master's producer.
  // Writing userData/config.json is THE EXCEPTION to the probe-family
  // read-only-userData discipline — initializing the install's config is
  // this tool's whole purpose. Atomic write, same as the checkpoint.
  const masterPath = path.join(app.getPath('userData'), 'config.json');
  writeJsonAtomic(masterPath, {
    safeDomains: finalPool,
    baseStreamUrls: bases
  });
  setupLog('master', 'wrote local master ' + masterPath + ' (' + finalPool.length + ' domains)');

  const done = Object.keys(checkpoint.stations).length;
  console.log('[SETUP ] ---- summary ----');
  console.log(`[SETUP ] stations tested: ${done} (OK=${counts.OK || 0} RECOVERED=${counts.RECOVERED || 0} DEAD=${counts.DEAD || 0})${earlyStopped ? ' [PARTIAL: early-stop]' : ''}`);
  console.log(`[SETUP ] final pool: ${finalPool.length} domains (${initialDomains.length} proven + ${finalPool.length - initialDomains.length} new)`);
  console.log(`[SETUP ] wrote ${CHECKPOINT_PATH}`);
  console.log(`[SETUP ] wrote ${OUTPUT_PATH} (gist shape: safeDomains + baseStreamUrls)`);
  console.log('[SETUP ] paste-ready safeDomains:');
  console.log(JSON.stringify(finalPool));

  finish(earlyStopped ? 2 : 0, earlyStopped ? 'EARLY-STOP — site-wide condition; checkpoint saved, re-run with --resume' : 'COMPLETE');
}).catch((err) => {
  console.error('[SETUP ] FATAL', err && err.stack ? err.stack : err);
  process.exit(1);
});