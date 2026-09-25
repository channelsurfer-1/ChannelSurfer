let scheduleData = null;
let guideUnavailableSince = Date.now();
const GUIDE_ERROR_THRESHOLD_MS = 15000;
const GUIDE_STATUS_MIN_MS = 1000;
let guideStatusShownAt = null;
let programTimers = new Map();
let paneCount = 1;
let focusedPaneIndex = 0;
// Pane that should take audio focus when its stream next connects. Deferring
// the switch to connect-time avoids silence while a guide is being browsed.
let pendingFocusPane = -1;
let tooltipTimer = null;
let stationColumnWidth = 40;
let isResizingColumn = false;
// Set in onMouseUp when a column drag actually moved the mouse. The
// release-click that follows (wherever it lands) is swallowed once
// by the capture-phase click listener below. isResizingColumn cannot be
// used for this: it is cleared in onMouseUp, BEFORE the click event dispatches.
let suppressNextRowClick = false;

// Per-pane state (arrays grow/shrink with paneCount; index 0-based).
let panePrograms = [null];
let paneOverlayOpen = [false];
let paneScroll = [0];

const BASE_STREAM_URL_FALLBACK = 'https://dlive.sx/stream/stream-';
const STREAM_ATTEMPT_TIMEOUT_MS = 7000;

let streamBaseUrls = [BASE_STREAM_URL_FALLBACK];
const streamAttempts = new Map(); // pane element -> attempt
let debugMode = false;
const failedRecoveryCombos = new Set(); // recovery: tested-and-failed domain sets (session only)
let pendingRecoveryTest = null;         // recovery: { key, pane, domains } while a test retry is in flight
let pendingPromotionView = null;        // recovery: { pane, domains } while main runs the 60s soak

if (!document.getElementById('connecting-dots-style')) {
  const style = document.createElement('style');
  style.id = 'connecting-dots-style';
  style.textContent = `
    @keyframes dot-seq {
      0%   { opacity: 0; }
      20%  { opacity: 1; }
      60%  { opacity: 1; }
      80%  { opacity: 0; }
      100% { opacity: 0; }
    }
    .connecting-dots .dot {
      display: inline-block;
      opacity: 0;
      animation: dot-seq 1.2s ease-in-out infinite;
    }
    .connecting-dots .dot2 { animation-delay: 0.2s; }
    .connecting-dots .dot3 { animation-delay: 0.4s; }
  `;
  document.head.appendChild(style);
}

// Sequential "thinking" dots: each dot lights in turn, overlapping its
// neighbor (lit pair slides across). Each dot is its own element (CSS can't
// animate characters of a text node); base opacity:0 keeps delayed dots
// invisible until their turn.
function makeConnectingDots() {
  const wrap = document.createElement('span');
  wrap.className = 'connecting-dots';
  for (let i = 1; i <= 3; i++) {
    const d = document.createElement('span');
    d.className = 'dot dot' + i;
    d.textContent = '.';
    wrap.appendChild(d);
  }
  return wrap;
}

function sendIpc(channel, payload) {
  try {
    if (window.channelSurfer) {
      window.channelSurfer.send(channel, payload);
    }
  } catch (_) {}
}

function logToMain(message) {
  sendIpc('renderer-log', message);
}

function isDebug() {
  return debugMode;
}

// ---------- Control-pulse bounds broadcast ----------
// The host renderer does not see mousemove over a loaded <webview> guest.
// Main polls the OS cursor instead; this function feeds it the viewport-space
// rects of every visible webview every ~500 ms. Main adds win.getContentBounds()
// to convert to screen coordinates before comparing to the cursor position.
function broadcastWebviewBounds() {
  const panesContainer = document.getElementById('panes-container');
  if (!panesContainer) return;
  const entries = [];
  panesContainer.querySelectorAll('webview').forEach(wv => {
    if (wv.style.visibility === 'hidden') return;
    let wcId;
    try { wcId = wv.getWebContentsId(); } catch (_) { return; }
    if (typeof wcId !== 'number') return;
    const r = wv.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return;
    entries.push({
      webContentsId: wcId,
      x: Math.round(r.left),
      y: Math.round(r.top),
      w: Math.round(r.width),
      h: Math.round(r.height)
    });
  });
  if (entries.length > 0) {
    sendIpc('webview-bounds', { entries });
  }
}
// ---------- End control-pulse bounds broadcast ----------

// ---------- Pane helpers ----------

function allPanes() {
  const panesContainer = document.getElementById('panes-container');
  return Array.from(panesContainer.querySelectorAll('.view-pane'));
}

function getPane(index) {
  return allPanes()[index] || null;
}

function paneIndexOf(pane) {
  return allPanes().indexOf(pane);
}

function setContainerLayout() {
  const panesContainer = document.getElementById('panes-container');
  panesContainer.classList.remove('panes-1', 'panes-2', 'panes-3', 'panes-4');
  panesContainer.classList.add('panes-' + paneCount);
}

function applyPaneVisibility() {
  allPanes().forEach((pane, index) => {
    pane.style.display = index < paneCount ? '' : 'none';
  });
}

function applyFocusStyles() {
  allPanes().forEach((pane, index) => {
    pane.classList.toggle('focused', index < paneCount && index === focusedPaneIndex);
  });
}

function applyAudioState() {
  allPanes().forEach((pane, index) => {
    if (index >= paneCount) return;
    const guideOpen = !!pane.querySelector('.pane-schedule-overlay');
    const wv = pane.querySelector('webview');
    if (wv) {
      const focused = (index === focusedPaneIndex);
      try { wv.setAudioMuted(!focused); } catch (_) {}
      // Tell main the audible state of every stream webview so the player's
      // own control bar reflects reality (mute icon follows focus).
      let wcId = null;
      try { wcId = wv.getWebContentsId(); } catch (_) {}
      if (typeof wcId === 'number') {
        sendIpc('set-pane-audio-focus', { webContentsId: wcId, focused: focused });
      }
    }
    const soundBtn = pane.querySelector('.pane-sound-btn');
    if (soundBtn) {
      // Only meaningful when there's a choice between panes AND the guide
      // isn't covering this one — the icon shows which pane is audible
      // (accented) vs silent (greyed, click to hear).
      const active = (index === focusedPaneIndex);
      soundBtn.style.display = (paneCount > 1 && !guideOpen) ? '' : 'none';
      soundBtn.textContent = active ? '\u{1F50A}' : '\u{1F507}';
      soundBtn.classList.toggle('active', active);
    }
    // The guide button is meaningless while its own guide is open (Escape
    // or a row pick takes it from there). The × is hidden in the one true
    // no-op state: the single empty pane (the initial screen — closing it
    // just reopens the guide). Everywhere else it does real work: stops a
    // stream in single view, removes a slot in multi-view.
    const guideBtn = pane.querySelector('.pane-guide-btn');
    if (guideBtn) guideBtn.style.display = guideOpen ? 'none' : '';
    const closeBtn = pane.querySelector('.pane-close-btn');
    if (closeBtn) {
      closeBtn.style.display = (paneCount === 1 && !panePrograms[index]) ? 'none' : '';
    }
  });
}

function focusPane(index) {
  if (index < 0 || index >= paneCount) return;
  if (focusedPaneIndex === index) {
    applyAudioState();
    return;
  }
  focusedPaneIndex = index;
  applyFocusStyles();
  applyAudioState();
  if (isDebug()) {
    logToMain('[VIEW] audio focus -> pane ' + (index + 1));
  }
}

function addView() {
  if (paneCount >= 4) return;
  paneCount++;
  panePrograms.push(null);
  paneOverlayOpen.push(false);
  paneScroll.push(0);
  setContainerLayout();
  renderView();
  const newIndex = paneCount - 1;
  pendingFocusPane = newIndex;
  showScheduleOverlay(getPane(newIndex), newIndex, null);
  if (isDebug()) {
    logToMain('[VIEW] added pane ' + paneCount);
  }
}

function closePane(index) {
  const pane = getPane(index);
  if (!pane) return;

  cancelStreamAttempt(pane);
  pane.innerHTML = '';
  paneOverlayOpen[index] = false;

  if (paneCount <= 1) {
    // Closing the only pane just clears it back to an empty view.
    // paneScroll is preserved so the guide reopens where the user left it.
    panePrograms[0] = null;
    focusPane(0);
    renderView();
    return;
  }

  panePrograms.splice(index, 1);
  paneOverlayOpen.splice(index, 1);
  paneScroll.splice(index, 1);
  paneCount--;

  if (focusedPaneIndex > index) focusedPaneIndex--;
  else if (focusedPaneIndex === index) focusedPaneIndex = Math.min(index, paneCount - 1);

  setContainerLayout();
  renderView();
  if (isDebug()) {
    logToMain('[VIEW] closed pane ' + (index + 1) + '; paneCount=' + paneCount);
  }
}

function ensurePaneControls(pane) {
  if (pane.querySelector('.pane-controls')) return;

  const controls = document.createElement('div');
  controls.className = 'pane-controls';

  // Calendar button: open the guide over this pane WITHOUT changing the
  // layout. The stream (if any) keeps playing underneath; a row pick
  // replaces it, Escape closes the guide and reveals it. The button hides
  // itself while its guide is open (see applyAudioState).
  const guideBtn = document.createElement('button');
  guideBtn.className = 'pane-guide-btn';
  guideBtn.title = 'Show the guide';
  guideBtn.innerHTML = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="1.75" y="2.75" width="12.5" height="11.5" rx="2"/><line x1="1.75" y1="6.5" x2="14.25" y2="6.5"/><line x1="5" y1="1.25" x2="5" y2="4.25"/><line x1="11" y1="1.25" x2="11" y2="4.25"/></svg>';
  guideBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const idx = paneIndexOf(pane);
    if (idx === -1 || idx >= paneCount) return;
    const openOverlay = pane.querySelector('.pane-schedule-overlay');
    if (openOverlay) {
      openOverlay.remove();
      paneOverlayOpen[idx] = false;
      guideBtn.title = 'Show the guide';
    } else {
      showScheduleOverlay(pane, idx, panePrograms[idx]);
      guideBtn.title = 'Hide the guide';
    }
    applyAudioState(); // re-evaluate guide/× visibility
  });

  const soundBtn = document.createElement('button');
  soundBtn.className = 'pane-sound-btn';
  soundBtn.title = 'Play audio from this view';
  soundBtn.textContent = '\u{1F507}';
  soundBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    focusPane(paneIndexOf(pane));
  });

  const closeBtn = document.createElement('button');
  closeBtn.className = 'pane-close-btn';
  closeBtn.innerHTML = '&times;';
  closeBtn.title = 'Close this view';
  closeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    closePane(paneIndexOf(pane));
  });

  controls.appendChild(guideBtn);
  controls.appendChild(soundBtn);
  controls.appendChild(closeBtn);
  pane.appendChild(controls);
}

function ensurePlaceholder(pane, paneIndex) {
  if (!pane.querySelector('.pane-placeholder') && !pane.querySelector('webview') && !pane.querySelector('.pane-schedule-overlay')) {
    const placeholder = document.createElement('div');
    placeholder.className = 'pane-placeholder';
    placeholder.textContent = 'Click to select a program';
    pane.appendChild(placeholder);
  }
  if (!pane.dataset.clickBound) {
    pane.dataset.clickBound = '1';
    pane.addEventListener('click', () => {
      const i = paneIndexOf(pane);
      if (i === -1 || i >= paneCount) return;
      if (panePrograms[i]) return;
      if (pane.querySelector('.pane-schedule-overlay')) return;
      pendingFocusPane = i;
      showScheduleOverlay(pane, i, null);
    });
  }
  ensurePaneControls(pane);
}

// ---------- End pane helpers ----------

function extractChannelId(url) {
  const match = url.match(/stream-(\d+)\.php/);
  return match ? match[1] : null;
}

function createWebview(title, url) {
  const webview = document.createElement('webview');
  webview.src = url;
  webview.setAttribute('allowfullscreen', 'true');
  webview.setAttribute('webpreferences', 'webSecurity=no');
  webview.dataset.title = title;
  webview.dataset.channelId = extractChannelId(url) || '';

  webview.addEventListener('enter-html-full-screen', () => {
    webview.style.position = 'fixed';
    webview.style.top = '0';
    webview.style.left = '0';
    webview.style.width = '100vw';
    webview.style.height = '100vh';
    webview.style.zIndex = '9999';
  });

  webview.addEventListener('leave-html-full-screen', () => {
    webview.style.position = '';
    webview.style.top = '';
    webview.style.left = '';
    webview.style.width = '';
    webview.style.height = '';
    webview.style.zIndex = '';
  });

  return webview;
}

function buildPaneLabel(program, programName) {
  const label = document.createElement('div');
  label.className = 'pane-label';

  const logoImg = document.createElement('img');
  logoImg.className = 'pane-label-logo';
  const logoFileName = program.stationName.replace(/ USA$/i, '').trim();
  logoImg.src = `../images/logos/badges/${encodeURIComponent(logoFileName)}.png`;
  logoImg.onerror = function() {
    this.style.display = 'none';
  };

  const labelText = document.createElement('span');
  labelText.className = 'pane-label-text';
  labelText.textContent = programName;

  label.appendChild(logoImg);
  label.appendChild(labelText);
  return label;
}

function attachPaneLabel(pane, program, programName) {
  pane.appendChild(buildPaneLabel(program, programName));
}

// ---------- Stream attempt failover ----------

function cancelStreamAttempt(pane) {
  const attempt = streamAttempts.get(pane);
  if (!attempt) return;
  attempt.cancelled = true;
  if (attempt.timer) {
    clearTimeout(attempt.timer);
    attempt.timer = null;
  }
  if (attempt.webContentsId !== null) {
    sendIpc('unregister-stream-attempt', { webContentsId: attempt.webContentsId });
    attempt.webContentsId = null;
  }
  if (attempt.webview) {
    attempt.webview.remove();
    attempt.webview = null;
  }
  if (attempt.indicator) {
    attempt.indicator.remove();
    attempt.indicator = null;
  }
  streamAttempts.delete(pane);
}

function cancelAllStreamAttempts() {
  for (const pane of Array.from(streamAttempts.keys())) {
    cancelStreamAttempt(pane);
  }
}

function attemptStream(pane, paneIndex, stationName, dlhdId, programTitle) {
  cancelStreamAttempt(pane);
  pane.innerHTML = '';

  const attempt = {
    pane: pane,
    paneIndex: paneIndex,
    stationName: stationName,
    dlhdId: dlhdId,
    programTitle: programTitle,
    candidateIndex: 0,
    webview: null,
    webContentsId: null,
    timer: null,
    indicator: null,
    cancelled: false,
    overallStartTime: Date.now(),
    candidateStartTime: null
  };

  streamAttempts.set(pane, attempt);
  runStreamAttempt(attempt);
  ensurePaneControls(pane);
  applyAudioState();
}

function runStreamAttempt(attempt) {
  if (attempt.cancelled) return;

  if (attempt.candidateIndex >= streamBaseUrls.length) {
    failStreamAttempt(attempt);
    return;
  }

  attempt.candidateStartTime = Date.now();

  const baseUrl = streamBaseUrls[attempt.candidateIndex];
  const url = `${baseUrl}${attempt.dlhdId}.php`;

  if (isDebug()) {
    logToMain('[CAND] trying candidate ' + (attempt.candidateIndex + 1) + '/' + streamBaseUrls.length + ': ' + url);
  }

  const webview = createWebview(attempt.stationName, url);
  webview.style.visibility = 'hidden';
  attempt.webview = webview;
  attempt.pane.appendChild(webview);

  const indicator = document.createElement('div');
  indicator.style.position = 'absolute';
  indicator.style.top = '0';
  indicator.style.left = '0';
  indicator.style.right = '0';
  indicator.style.bottom = '0';
  indicator.style.display = 'flex';
  indicator.style.alignItems = 'center';
  indicator.style.justifyContent = 'center';
  indicator.style.fontSize = '1rem';
  indicator.style.zIndex = '100';
  const labelSpan = document.createElement('span');
  labelSpan.textContent = 'Connecting';
  labelSpan.appendChild(makeConnectingDots());
  indicator.appendChild(labelSpan);
  attempt.indicator = indicator;
  attempt.pane.appendChild(indicator);

  const thisWebview = webview;

  webview.addEventListener('dom-ready', () => {
    if (attempt.cancelled || attempt.webview !== thisWebview) return;
    try {
      const id = thisWebview.getWebContentsId();
      attempt.webContentsId = id;
      sendIpc('register-stream-attempt', { webContentsId: id });
      applyAudioState(); // publish this webview's focus state to main
      if (isDebug()) {
        logToMain('[CAND] candidate ' + (attempt.candidateIndex + 1) + ' dom-ready wc=' + id);
      }
    } catch (_) {}
  });

  webview.addEventListener('did-fail-load', (e) => {
    if (attempt.cancelled || attempt.webview !== thisWebview) return;
    if (!e.isMainFrame) return;
    if (e.errorCode === -3) return; // ERR_ABORTED
    if (isDebug()) {
      logToMain('[CAND] candidate ' + (attempt.candidateIndex + 1) + ' did-fail-load code=' + e.errorCode + ' desc=' + (e.errorDescription || '?'));
    }
    advanceStreamAttempt(attempt);
  });

  webview.addEventListener('console-message', (e) => {
    if (attempt.cancelled || attempt.webview !== thisWebview) return;
    if (!isDebug() && e.message.includes('announce error')) return;
    if (e.level >= 2 || (isDebug() && !e.message.includes('[object Object]'))) {
      logToMain('[WV:' + attempt.dlhdId + '] ' + e.message);
    }
  });

  attempt.timer = setTimeout(() => {
    if (attempt.cancelled || attempt.webview !== thisWebview) return;
    advanceStreamAttempt(attempt);
  }, STREAM_ATTEMPT_TIMEOUT_MS);
}

function advanceStreamAttempt(attempt) {
  if (attempt.cancelled) return;

  const elapsed = attempt.candidateStartTime
    ? ((Date.now() - attempt.candidateStartTime) / 1000).toFixed(1)
    : '?';
  logToMain(`Stream candidate ${attempt.candidateIndex + 1}/${streamBaseUrls.length} failed after ${elapsed}s`);

  if (attempt.timer) {
    clearTimeout(attempt.timer);
    attempt.timer = null;
  }
  if (attempt.webContentsId !== null) {
    sendIpc('unregister-stream-attempt', { webContentsId: attempt.webContentsId });
    attempt.webContentsId = null;
  }
  if (attempt.webview) {
    attempt.webview.remove();
    attempt.webview = null;
  }
  if (attempt.indicator) {
    attempt.indicator.remove();
    attempt.indicator = null;
  }

  attempt.candidateIndex++;
  runStreamAttempt(attempt);
}

function succeedStreamAttempt(attempt) {
  streamAttempts.delete(attempt.pane);

  const elapsed = attempt.candidateStartTime
    ? ((Date.now() - attempt.candidateStartTime) / 1000).toFixed(1)
    : '?';
  logToMain(`Stream connected in ${elapsed}s (candidate ${attempt.candidateIndex + 1}/${streamBaseUrls.length})`);

  if (pendingRecoveryTest && pendingRecoveryTest.pane === attempt.pane) {
    logToMain('[RECOVERY] test PASSED, domains: ' + pendingRecoveryTest.key.split('|').join(', '));
    pendingPromotionView = { pane: attempt.pane, domains: pendingRecoveryTest.domains };
    sendIpc('recovery-test-result', { domains: pendingRecoveryTest.domains, passed: true });
    pendingRecoveryTest = null;
  }

  if (attempt.timer) {
    clearTimeout(attempt.timer);
    attempt.timer = null;
  }
  if (attempt.webContentsId !== null) {
    sendIpc('unregister-stream-attempt', { webContentsId: attempt.webContentsId });
    attempt.webContentsId = null;
  }
  if (attempt.indicator) {
    attempt.indicator.remove();
    attempt.indicator = null;
  }
  if (attempt.webview) {
    attempt.webview.style.visibility = '';
  }
  attachPaneLabel(attempt.pane, { stationName: attempt.stationName }, attempt.programTitle || attempt.stationName);
  // Audio focus moves to this pane only if a pick/add designated it; this
  // keeps failover reconnections from stealing audio back.
  if (pendingFocusPane === attempt.paneIndex) {
    pendingFocusPane = -1;
    focusPane(attempt.paneIndex);
  }
  applyAudioState();
}

function failStreamAttempt(attempt) {
  streamAttempts.delete(attempt.pane);
  if (pendingFocusPane === attempt.paneIndex) pendingFocusPane = -1;

  const elapsed = attempt.overallStartTime
    ? ((Date.now() - attempt.overallStartTime) / 1000).toFixed(1)
    : '?';
  logToMain(`Stream failed: all ${streamBaseUrls.length} candidates exhausted after ${elapsed}s`);

  if (attempt.webview) {
    attempt.webview.remove();
    attempt.webview = null;
  }
  if (attempt.indicator) {
    attempt.indicator.remove();
    attempt.indicator = null;
  }

  const failure = document.createElement('div');
  failure.className = 'pane-failure';
  failure.style.position = 'absolute';
  failure.style.top = '0';
  failure.style.left = '0';
  failure.style.right = '0';
  failure.style.bottom = '0';
  failure.style.display = 'flex';
  failure.style.alignItems = 'center';
  failure.style.justifyContent = 'center';
  failure.style.background = 'rgba(0,0,0,0.85)';
  failure.style.color = '#f88';
  failure.style.fontSize = '1rem';
  failure.style.textAlign = 'center';
  failure.style.padding = '20px';
  failure.textContent = 'Could not connect to server.';
  attempt.pane.appendChild(failure);

  if (pendingRecoveryTest && pendingRecoveryTest.pane === attempt.pane) {
    failedRecoveryCombos.add(pendingRecoveryTest.key);
    logToMain('[RECOVERY] test failed, combo remembered: ' + pendingRecoveryTest.key.split('|').join(', '));
    sendIpc('recovery-test-result', { domains: pendingRecoveryTest.domains, passed: false });
    pendingRecoveryTest = null;
  }
  if (pendingPromotionView && pendingPromotionView.pane === attempt.pane) {
    pendingPromotionView = null;
  }

  if (isDebug()) {
    openRecoveryDialog(attempt);
  }
}

function recoveryComboKey(domains) {
  return domains.slice().sort().join('|');
}

function mkRecoveryBtn(label, primary) {
  const b = document.createElement('button');
  b.textContent = label;
  b.style.cssText = 'padding:8px 16px;border-radius:8px;cursor:pointer;font-size:14px;' +
    (primary
      ? 'background:#eee;color:#111;border:none;font-weight:600;'
      : 'background:transparent;color:#eee;border:1px solid #666;');
  return b;
}

function showRecoverySuccess(pane, domains) {
  const old = pane.querySelector('.recovery-overlay');
  if (old) old.remove();

  const overlay = document.createElement('div');
  overlay.className = 'recovery-overlay';
  overlay.style.cssText = 'position:absolute;top:0;left:0;right:0;bottom:0;background:rgba(10,10,12,0.94);color:#eee;z-index:200;display:flex;align-items:center;justify-content:center;font-size:14px;';

  const box = document.createElement('div');
  box.style.cssText = 'max-width:92%;max-height:92%;overflow:auto;padding:20px 22px;';

  const title = document.createElement('div');
  title.style.cssText = 'font-size:17px;font-weight:600;color:#7d7;margin-bottom:4px;';
  title.textContent = 'Recovered — saved locally';
  box.appendChild(title);

  const sub = document.createElement('div');
  sub.style.cssText = 'color:#999;font-size:13px;margin-bottom:14px;';
  sub.textContent = domains.join(', ') + ' added to local config after 60s of stable playback.';
  box.appendChild(sub);

  const snipLabel = document.createElement('div');
  snipLabel.style.cssText = 'color:#ccc;font-size:13px;';
  snipLabel.textContent = 'Share with other installs — add to the gist manually:';
  box.appendChild(snipLabel);

  const snippet = '// safeDomains additions — paste into gist config.json\n' + domains.map(d => '"' + d + '",').join('\n');
  const snip = document.createElement('div');
  snip.style.cssText = 'font-family:monospace;font-size:13px;line-height:20px;border:1px solid #444;border-radius:8px;padding:8px 12px;margin:8px 0;white-space:pre;color:#eee;';
  snip.textContent = snippet;
  box.appendChild(snip);

  const btns = document.createElement('div');
  btns.style.cssText = 'display:flex;gap:10px;margin-top:14px;';
  const copyBtn = mkRecoveryBtn('Copy snippet', true);
  const doneBtn = mkRecoveryBtn('Done', false);
  btns.appendChild(copyBtn);
  btns.appendChild(doneBtn);
  box.appendChild(btns);

  const note = document.createElement('div');
  note.style.cssText = 'color:#777;font-size:12px;margin-top:12px;';
  note.textContent = 'Local until shared — the gist update stays manual. A startup reminder lists anything local-only.';
  box.appendChild(note);

  copyBtn.addEventListener('click', () => {
    sendIpc('copy-text', snippet);
    copyBtn.textContent = 'Copied';
  });
  doneBtn.addEventListener('click', () => overlay.remove());

  overlay.appendChild(box);
  pane.appendChild(overlay);
}

// Opens the recovery dialog inside the failed pane. Debug-gated by the caller.
async function openRecoveryDialog(attempt) {
  const pane = attempt.pane;
  if (!pane) return;
  const old = pane.querySelector('.recovery-overlay');
  if (old) old.remove();

  const overlay = document.createElement('div');
  overlay.className = 'recovery-overlay';
  overlay.style.cssText = 'position:absolute;top:0;left:0;right:0;bottom:0;background:rgba(10,10,12,0.94);color:#eee;z-index:200;display:flex;align-items:center;justify-content:center;font-size:14px;';

  const box = document.createElement('div');
  box.style.cssText = 'max-width:92%;max-height:92%;overflow:auto;padding:20px 22px;';

  const closeX = document.createElement('button');
  closeX.textContent = '×';
  closeX.title = 'Close';
  closeX.style.cssText = 'position:absolute;top:8px;right:12px;background:none;border:none;color:#999;font-size:20px;cursor:pointer;';
  overlay.appendChild(closeX);

  const title = document.createElement('div');
  title.style.cssText = 'font-size:17px;font-weight:600;color:#f88;margin-bottom:4px;';
  title.textContent = 'Stream unavailable — channel ' + attempt.dlhdId;
  box.appendChild(title);

  const sub = document.createElement('div');
  sub.style.cssText = 'color:#999;font-size:13px;margin-bottom:14px;';
  sub.textContent = 'All ' + streamBaseUrls.length + ' sources failed · recovery options';
  box.appendChild(sub);

  const diag = document.createElement('div');
  diag.style.cssText = 'color:#ccc;margin-bottom:14px;line-height:1.45;';
  diag.textContent = 'Checking for blocked domains in the player chain…';
  box.appendChild(diag);

  const listHost = document.createElement('div');
  box.appendChild(listHost);

  const btns = document.createElement('div');
  btns.style.cssText = 'display:flex;gap:10px;margin-top:16px;flex-wrap:wrap;';
  box.appendChild(btns);

  overlay.appendChild(box);
  pane.appendChild(overlay);
  closeX.addEventListener('click', () => overlay.remove());

  let data;
  try {
    data = await window.channelSurfer.invoke('get-recovery-candidates');
  } catch (_) {
    data = { enabled: false, candidates: [] };
  }

  if (!data.enabled || !data.candidates || data.candidates.length === 0) {
    diag.textContent = (!data.enabled)
      ? 'Recovery dialog is disabled (debug mode off).'
      : 'No candidate domains found — this failure is likely not a blocked-domain issue.';
    const closeBtn = mkRecoveryBtn('Close', false);
    closeBtn.addEventListener('click', () => overlay.remove());
    btns.appendChild(closeBtn);
    return;
  }

  diag.textContent = 'New domains in the player chain were blocked. They are tested together as a set — only kept if playback actually recovers. Uncheck anything that looks like an ad.';

  const checks = [];
  data.candidates.forEach(c => {
    const row = document.createElement('label');
    row.style.cssText = 'display:flex;align-items:center;gap:10px;padding:8px 10px;border:1px solid #444;border-radius:8px;margin-bottom:8px;cursor:pointer;';

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!c.checked;
    cb.dataset.domain = c.domain;
    cb.style.cssText = 'width:15px;height:15px;flex:none;accent-color:#ddd;';

    const grow = document.createElement('div');
    grow.style.cssText = 'flex:1;min-width:0;';
    const name = document.createElement('div');
    name.style.cssText = 'font-family:monospace;font-size:13px;';
    name.textContent = c.domain;
    const meta = document.createElement('div');
    meta.style.cssText = 'color:#999;font-size:12px;';
    meta.textContent = 'blocked ' + c.count + '× · ref ' + c.refHost;
    grow.appendChild(name);
    grow.appendChild(meta);

    const tag = document.createElement('span');
    const tagText = { 'chain': 'chain', 'chain?': 'chain?', 'likely-ad': 'likely ad' };
    const isChain = c.tag === 'chain';
    tag.style.cssText = 'font-size:11px;padding:2px 8px;border-radius:5px;flex:none;' +
      (isChain ? 'background:rgba(80,200,120,0.15);color:#7d7;' : 'background:rgba(240,180,60,0.15);color:#fc7;');
    tag.textContent = tagText[c.tag] || c.tag;

    row.appendChild(cb);
    row.appendChild(grow);
    row.appendChild(tag);
    listHost.appendChild(row);
    checks.push(cb);
  });

  const testBtn = mkRecoveryBtn('Test selected', true);
  const retryBtn = mkRecoveryBtn('Retry without changes', false);
  const closeBtn = mkRecoveryBtn('Close', false);
  btns.appendChild(testBtn);
  btns.appendChild(retryBtn);
  btns.appendChild(closeBtn);

  closeBtn.addEventListener('click', () => overlay.remove());
  retryBtn.addEventListener('click', () => {
    overlay.remove();
    attemptStream(attempt.pane, attempt.paneIndex, attempt.stationName, attempt.dlhdId, attempt.programTitle);
  });
  testBtn.addEventListener('click', () => {
    const selected = checks.filter(c => c.checked).map(c => c.dataset.domain);
    if (selected.length === 0) {
      diag.textContent = 'Select at least one domain to test.';
      return;
    }
    const key = recoveryComboKey(selected);
    if (failedRecoveryCombos.has(key)) {
      diag.textContent = 'That combination already failed this session — try a different selection.';
      return;
    }
    pendingRecoveryTest = { key, pane: attempt.pane, domains: selected };
    sendIpc('allow-recovery-domains', selected);
    logToMain('[RECOVERY] testing domains: ' + selected.join(', '));
    overlay.remove();
    attemptStream(attempt.pane, attempt.paneIndex, attempt.stationName, attempt.dlhdId, attempt.programTitle);
  });
}

// ---------- End stream attempt failover ----------

function showTooltip(e) {
  const title = e.currentTarget.dataset.tooltipTitle;
  const desc = e.currentTarget.dataset.tooltipDesc;
  if (!title && !desc) return;

  tooltipTimer = setTimeout(() => {
    const tooltip = document.getElementById('tooltip');
    tooltip.textContent = '';
    if (title) {
      const strong = document.createElement('strong');
      strong.textContent = title;
      tooltip.appendChild(strong);
      if (desc) {
        tooltip.appendChild(document.createElement('br'));
      }
    }
    if (desc) {
      tooltip.appendChild(document.createTextNode(desc));
    }
    tooltip.style.display = 'block';
    moveTooltip(e);
  }, 500);
}

function moveTooltip(e) {
  const tooltip = document.getElementById('tooltip');
  const tooltipWidth = tooltip.offsetWidth;
  const tooltipHeight = tooltip.offsetHeight;
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;

  let left = e.clientX + 12;
  let top = e.clientY + 12;

  if (left + tooltipWidth > viewportWidth - 10) {
    left = e.clientX - tooltipWidth - 12;
  }

  if (top + tooltipHeight > viewportHeight - 10) {
    top = e.clientY - tooltipHeight - 12;
  }

  tooltip.style.left = left + 'px';
  tooltip.style.top = top + 'px';
}

function hideTooltip() {
  if (tooltipTimer) {
    clearTimeout(tooltipTimer);
    tooltipTimer = null;
  }
  const tooltip = document.getElementById('tooltip');
  if (tooltip) tooltip.style.display = 'none';
}

function isScheduleFresh(data) {
  if (!data || !data.generatedAt) return false;
  const generated = new Date(data.generatedAt);
  if (isNaN(generated.getTime())) return false;
  const now = new Date();
  return generated.getUTCFullYear() === now.getUTCFullYear() &&
         generated.getUTCMonth() === now.getUTCMonth() &&
         generated.getUTCDate() === now.getUTCDate();
}

function updateGuideStatusScreen() {
  const el = document.getElementById('guide-status-screen');
  if (!el) return;
  if (scheduleData) {
    const shownMs = guideStatusShownAt ? Date.now() - guideStatusShownAt : Infinity;
    if (shownMs >= GUIDE_STATUS_MIN_MS) {
      el.remove();
      guideStatusShownAt = null;
      return;
    }
    setTimeout(() => {
      if (el.isConnected) updateGuideStatusScreen();
    }, GUIDE_STATUS_MIN_MS - shownMs);
    return;
  }

  const unavailableMs = guideUnavailableSince ? Date.now() - guideUnavailableSince : 0;
  el.textContent = '';
  const label = document.createElement('span');
  if (unavailableMs >= GUIDE_ERROR_THRESHOLD_MS) {
    label.textContent = 'Unable to load program guide...';
  } else {
    label.textContent = 'Loading the program guide';
    label.appendChild(makeConnectingDots());

    const remaining = GUIDE_ERROR_THRESHOLD_MS - unavailableMs;
    if (remaining > 0) {
      setTimeout(() => {
        if (el.isConnected) updateGuideStatusScreen();
      }, remaining);
    }
  }
  el.appendChild(label);
}

function getCurrentProgramInfo(dlhdId) {
  if (!scheduleData || !scheduleData.stations) return null;

  const nowMs = Date.now();

  for (const [stationName, stationObj] of Object.entries(scheduleData.stations)) {
    if (stationObj.dlhdId === dlhdId) {
      const slots = stationObj.slots || [];
      const currentSlot = slots.find(s => nowMs >= s.startMs && nowMs < s.stopMs);
      if (currentSlot) {
        const textarea = document.createElement('textarea');
        textarea.innerHTML = currentSlot.program;
        return {
          programName: textarea.value,
          stopMs: currentSlot.stopMs
        };
      }
      return {
        programName: stationName.replace(/ USA$/i, '').trim(),
        stopMs: nowMs + 60000
      };
    }
  }

  return null;
}

function scheduleProgramTimer(dlhdId) {
  if (programTimers.has(dlhdId)) {
    clearTimeout(programTimers.get(dlhdId));
    programTimers.delete(dlhdId);
  }

  const programInfo = getCurrentProgramInfo(dlhdId);
  if (!programInfo) return;

  const timeUntilEnd = programInfo.stopMs - Date.now();

  const timer = setTimeout(() => {
    const nextProgramInfo = getCurrentProgramInfo(dlhdId);
    if (nextProgramInfo) {
      updatePaneLabel(dlhdId, nextProgramInfo.programName);
      scheduleProgramTimer(dlhdId);
    }
  }, timeUntilEnd + 1000);

  programTimers.set(dlhdId, timer);
}

function updatePaneLabel(dlhdId, programName) {
  allPanes().forEach((pane, index) => {
    const program = index < paneCount ? panePrograms[index] : null;
    if (program && program.dlhdId === dlhdId) {
      const existingLabel = pane.querySelector('.pane-label');
      if (existingLabel) existingLabel.remove();
      pane.appendChild(buildPaneLabel(program, programName));
    }
  });
}

function renderView() {
  applyPaneVisibility();

  // Reconciliation invariant: visible slot i shows panePrograms[i]; hidden
  // slots are empty. A survivor webview left parked in a now-hidden div
  // (when a pane above it was closed) would keep playing invisibly — tear
  // it down. Webviews are never moved between divs: moving the element
  // kills the guest (Spike 1), so a displaced survivor is re-streamed in
  // place instead.
  allPanes().forEach((pane, index) => {
    if (index >= paneCount && pane.firstChild) {
      cancelStreamAttempt(pane);
      pane.innerHTML = '';
    }
  });

  for (let index = 0; index < paneCount; index++) {
    const pane = getPane(index);
    if (!pane) continue;
    const program = panePrograms[index];
    if (program) {
      const attempt = streamAttempts.get(pane);
      const wv = pane.querySelector('webview');
      // A webview parked here by a pre-close survivor belongs to the
      // program that USED to hold this slot; only a channel match proves
      // this div is showing the program the slot now calls for.
      // Otherwise tear down and re-stream (attemptStream replaces
      // whatever is in the pane).
      const hasMatchingWebview = !!wv && wv.dataset.channelId === String(program.dlhdId);
      if (!attempt && !hasMatchingWebview) {
        attemptStream(pane, index, program.stationName, program.dlhdId, program.programName);
      } else {
        ensurePaneControls(pane);
      }
    } else {
      ensurePlaceholder(pane, index);
    }
  }

  applyFocusStyles();
  applyAudioState();

  if (paneCount === 1 && !panePrograms[0] && scheduleData) {
    showScheduleOverlay(getPane(0), 0, null);
    return;
  }

  paneOverlayOpen.forEach((isOpen, index) => {
    if (isOpen && index < paneCount) {
      const pane = getPane(index);
      if (pane && !pane.querySelector('.pane-schedule-overlay')) {
        showScheduleOverlay(pane, index, panePrograms[index]);
      }
    }
  });

  updateAddViewButtonVisibility();
}

function showScheduleOverlay(pane, paneIndex, existingProgram) {
  // One overlay at a time, app-wide: opening one closes the others.
  allPanes().forEach((otherPane, index) => {
    if (otherPane === pane || index >= paneCount) return;

    const otherOverlay = otherPane.querySelector('.pane-schedule-overlay');
    if (otherOverlay) {
      const otherListContainer = otherOverlay.querySelector('.pane-schedule-list');
      if (otherListContainer) {
        if (isDebug()) {
          logToMain('[SCHED] save scroll pane ' + index + ' (other-close): ' + otherListContainer.scrollTop + ' (store was ' + paneScroll[index] + ')');
        }
        paneScroll[index] = otherListContainer.scrollTop;
      }

      otherOverlay.remove();
      paneOverlayOpen[index] = false;

      const otherProgram = index < paneCount ? panePrograms[index] : null;
      if (otherProgram) {
        const existingWebview = otherPane.querySelector('webview');
        if (existingWebview) {
          existingWebview.style.display = '';
        }

        if (!otherPane.querySelector('.pane-label') && otherProgram.programName) {
          otherPane.appendChild(buildPaneLabel(otherProgram, otherProgram.programName));
        }
      } else {
        ensurePlaceholder(otherPane, index);
      }
    }
  });

  paneOverlayOpen[paneIndex] = true;

  const existingOverlay = pane.querySelector('.pane-schedule-overlay');
  if (existingOverlay) {
    const existingListContainer = existingOverlay.querySelector('.pane-schedule-list');
    if (existingListContainer) {
      if (isDebug()) {
        logToMain('[SCHED] save scroll pane ' + paneIndex + ' (reopen): ' + existingListContainer.scrollTop + ' (store was ' + paneScroll[paneIndex] + ')');
      }
      paneScroll[paneIndex] = existingListContainer.scrollTop;
    }
    existingOverlay.remove();
  }

  const overlay = document.createElement('div');
  overlay.className = 'pane-schedule-overlay';

  const header = document.createElement('div');
  header.className = 'pane-schedule-header';

  const stationHeader = document.createElement('div');
  stationHeader.className = 'pane-schedule-header-station';
  stationHeader.textContent = 'Channel';
  header.appendChild(stationHeader);

  const programHeader = document.createElement('div');
  programHeader.className = 'pane-schedule-header-program';
  programHeader.textContent = 'Program';
  header.appendChild(programHeader);

  overlay.appendChild(header);

  const listContainer = document.createElement('div');
  listContainer.className = 'pane-schedule-list';
  overlay.appendChild(listContainer);

  pane.appendChild(overlay);

  populateScheduleList(listContainer, pane, paneIndex);

  listContainer.scrollTop = paneScroll[paneIndex] || 0;
  if (isDebug()) {
    logToMain('[SCHED] restore scroll pane ' + paneIndex + ': ' + listContainer.scrollTop);
  }

  // The overlay now exists; refresh button visibility (the guide button
  // hides itself while its guide is open; the × hides on empty-pane
  // guides and in single view).
  applyAudioState();
}

function populateScheduleList(listContainer, pane, paneIndex) {
  if (!scheduleData || !scheduleData.stations) {
    const msgRow = document.createElement('div');
    msgRow.className = 'pane-schedule-row';
    msgRow.style.cssText = 'color:#999;font-size:13px;padding:14px 12px;';

    const unavailableMs = guideUnavailableSince ? Date.now() - guideUnavailableSince : 0;
    if (unavailableMs >= GUIDE_ERROR_THRESHOLD_MS) {
      msgRow.textContent = "Can't load program guide.";
    } else {
      const labelSpan = document.createElement('span');
      labelSpan.textContent = 'Loading the program guide';
      labelSpan.appendChild(makeConnectingDots());
      msgRow.appendChild(labelSpan);

      const remaining = GUIDE_ERROR_THRESHOLD_MS - unavailableMs;
      if (remaining > 0) {
        setTimeout(() => {
          if (msgRow.isConnected && !scheduleData) {
            msgRow.textContent = "Can't load program guide.";
          }
        }, remaining);
      }
    }

    listContainer.appendChild(msgRow);
    return;
  }

  const nowMs = Date.now();
  const stationsEntries = Object.entries(scheduleData.stations);
  stationsEntries.sort((a, b) => a[0].localeCompare(b[0]));

  stationsEntries.forEach(([stationName, stationObj]) => {
    const row = document.createElement('div');
    row.className = 'pane-schedule-row';
    // Mark the row that is THIS pane's current program — the
    // "back to what I was watching" row. Stations playing in other panes
    // are not marked; the highlight is pane-scoped.
    if (panePrograms[paneIndex] && panePrograms[paneIndex].dlhdId === stationObj.dlhdId) {
      row.classList.add('is-current');
    }

    const stationSpan = document.createElement('div');
    stationSpan.className = 'pane-schedule-station';
    stationSpan.style.width = stationColumnWidth + '%';
    stationSpan.style.minWidth = stationColumnWidth + '%';
    const displayName = stationName.replace(/ USA$/i, '').trim();

    const logoImg = document.createElement('img');
    logoImg.className = 'pane-schedule-logo';
    const logoFileName = stationName.replace(/ USA$/i, '').trim();
    logoImg.src = `../images/logos/badges/${encodeURIComponent(logoFileName)}.png`;
    logoImg.alt = displayName;
    logoImg.onerror = function() {
      this.style.display = 'none';
    };

    stationSpan.appendChild(logoImg);

    const stationText = document.createElement('span');
    stationText.className = 'pane-schedule-station-text';
    stationText.textContent = displayName;

    stationSpan.appendChild(stationText);

    row.appendChild(stationSpan);

    const stationResizer = document.createElement('div');
    stationResizer.className = 'pane-schedule-station-resizer';
    row.appendChild(stationResizer);

    const programSpan = document.createElement('div');
    programSpan.className = 'pane-schedule-program';

    const slots = stationObj.slots || [];
    const currentSlot = slots.find(s => nowMs >= s.startMs && nowMs < s.stopMs);

    let programTitle = '';
    let programDescription = 'No description available';

    if (currentSlot) {
      const textarea = document.createElement('textarea');
      textarea.innerHTML = currentSlot.program;
      programTitle = textarea.value;
      programSpan.textContent = programTitle;
      programSpan.classList.add('is-live');

      if (currentSlot.description) {
        const descTextarea = document.createElement('textarea');
        descTextarea.innerHTML = currentSlot.description;
        programDescription = descTextarea.value;
      }
    } else {
      programSpan.textContent = 'No program data';
    }

    row.appendChild(programSpan);

    programSpan.dataset.tooltipTitle = programTitle;
    programSpan.dataset.tooltipDesc = programDescription;
    programSpan.addEventListener('mouseenter', showTooltip);
    programSpan.addEventListener('mousemove', moveTooltip);
    programSpan.addEventListener('mouseleave', hideTooltip);

    // Keep the header divider pinned to the same pixel position as the row
    // dividers. % alone can't do it: the header spans the full overlay width
    // while the list is narrower by the scrollbar, so equal percentages
    // land on different pixels. Same px for both = always aligned, and the
    // header follows every drag and every repopulate.
    const listWidthNow = listContainer.clientWidth;
    const dividerPx = (stationColumnWidth / 100) * listWidthNow;
    const headerStation = pane.querySelector('.pane-schedule-header-station');
    if (headerStation) {
      headerStation.style.width = dividerPx + 'px';
      headerStation.style.minWidth = dividerPx + 'px';
    }

    row.addEventListener('click', (e) => {
      if (isResizingColumn) return;

      e.stopPropagation();

      hideTooltip();

      const currentList = pane.querySelector('.pane-schedule-list');
      if (currentList) {
        if (isDebug()) {
          logToMain('[SCHED] save scroll pane ' + paneIndex + ' (row-click): ' + currentList.scrollTop);
        }
        paneScroll[paneIndex] = currentList.scrollTop;
      }

      // Re-picking the program already playing in this pane = "back to
      // what I was watching": just dismiss the guide; the stream never
      // stops. Any other row replaces the stream as usual. Health check
      // required: same channel, no failover in flight, live webview
      // actually showing it — otherwise a click re-streams.
      const currentProgram = panePrograms[paneIndex];
      const wv = pane.querySelector('webview');
      const alreadyPlaying = currentProgram &&
        currentProgram.dlhdId === stationObj.dlhdId &&
        !streamAttempts.has(pane) &&
        wv && !wv.dataset.dead && wv.dataset.channelId === String(stationObj.dlhdId);
      if (alreadyPlaying) {
        const overlay = pane.querySelector('.pane-schedule-overlay');
        if (overlay) overlay.remove();
        paneOverlayOpen[paneIndex] = false;
        applyAudioState();
        return;
      }

      panePrograms[paneIndex] = {
        stationName: displayName,
        dlhdId: stationObj.dlhdId,
        programName: programTitle
      };

      paneOverlayOpen[paneIndex] = false;

      scheduleProgramTimer(stationObj.dlhdId);

      pendingFocusPane = paneIndex;

      attemptStream(pane, paneIndex, displayName, stationObj.dlhdId, programTitle);
    });

    listContainer.appendChild(row);
  });
}

document.addEventListener('DOMContentLoaded', () => {
  let schedulePath = '../data/schedule.json';

  const addViewBtn = document.getElementById('add-view-btn');
  if (addViewBtn) {
    addViewBtn.addEventListener('click', () => addView());
  }

  // Escape closes the open guide (one overlay app-wide), revealing the
  // still-playing stream underneath. The guide button is hidden while its
  // guide is open, so this is the way back without picking a channel.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const openOverlay = document.querySelector('.view-pane .pane-schedule-overlay');
    if (!openOverlay) return;
    const pane = openOverlay.parentElement;
    const idx = paneIndexOf(pane);
    if (idx === -1) return;
    openOverlay.remove();
    paneOverlayOpen[idx] = false;
    applyAudioState();
  });

  // Swallow the release-click that follows a real column drag, wherever it
  // lands. Capture phase runs before every row handler. The flag is set in
  // onMouseUp (which runs BEFORE the click dispatches) and cleared here.
  document.addEventListener('click', (e) => {
    if (suppressNextRowClick) {
      suppressNextRowClick = false;
      e.stopPropagation();
      e.preventDefault();
    }
  }, true);

  document.addEventListener('mousedown', (e) => {
    if (e.target.classList.contains('pane-schedule-station-resizer')) {
      e.stopPropagation();
      e.preventDefault();
      isResizingColumn = true;

      const startX = e.clientX;
      const startY = e.clientY;
      const startWidthPercent = stationColumnWidth;
      let moved = false;

      const onMouseMove = (moveEvent) => {
        if (Math.abs(moveEvent.clientX - startX) > 3 || Math.abs(moveEvent.clientY - startY) > 3) {
          moved = true;
        }

        const list = document.querySelector('.view-pane .pane-schedule-list');
        if (!list) return;

        // Rows live in the list, whose width excludes the vertical scrollbar
        // (~6px). That coordinate space is the source of truth for the
        // divider: percentages of the overlay width drift ~2px against the
        // rows once the scrollbar appears.
        const listWidth = list.clientWidth;
        const deltaPercent = ((moveEvent.clientX - startX) / listWidth) * 100;
        const newWidth = startWidthPercent + deltaPercent;

        if (newWidth >= 20 && newWidth <= 60) {
          stationColumnWidth = newWidth;
          const px = (newWidth / 100) * listWidth;
          // Header cell moves in lockstep with the row cells — same px,
          // since both containers share the same left edge.
          document.querySelectorAll('.pane-schedule-station').forEach(station => {
            station.style.width = px + 'px';
            station.style.minWidth = px + 'px';
          });
          document.querySelectorAll('.pane-schedule-header-station').forEach(header => {
            header.style.width = px + 'px';
            header.style.minWidth = px + 'px';
          });
        }
      };

      const onMouseUp = () => {
        isResizingColumn = false;
        if (moved) suppressNextRowClick = true;
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        document.body.style.cursor = 'default';
      };

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
      document.body.style.cursor = 'col-resize';
    }
  });

  async function loadSchedule() {
    try {
      const cacheBuster = `?_=${Date.now()}`;
      const response = await fetch(`${schedulePath}${cacheBuster}`);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const data = await response.json();
      if (!isScheduleFresh(data)) {
        if (isDebug()) {
          logToMain('[SCHED] stale or unlabeled schedule rejected; retrying');
        }
        scheduleData = null;
        guideUnavailableSince = guideUnavailableSince || Date.now();
        updateGuideStatusScreen();
        throw new Error('stale schedule');
      }
      if (guideStatusShownAt && Date.now() - guideStatusShownAt < GUIDE_STATUS_MIN_MS) {
        await new Promise(resolve => setTimeout(resolve, GUIDE_STATUS_MIN_MS - (Date.now() - guideStatusShownAt)));
      }
      const hadDataBefore = scheduleData !== null;
      scheduleData = data;
      guideUnavailableSince = null;
      updateGuideStatusScreen();
      if (isDebug()) {
        logToMain('[SCHED] load OK; hadDataBefore=' + hadDataBefore);
      }

      panePrograms.forEach(program => {
        if (program) {
          const info = getCurrentProgramInfo(program.dlhdId);
          if (info) {
            updatePaneLabel(program.dlhdId, info.programName);
          }
          scheduleProgramTimer(program.dlhdId);
        }
      });

      renderView();
    } catch (err) {
      if (isDebug()) {
        logToMain('[SCHED] load failed (' + (err && err.message ? err.message : '?') + '); retry in 2s');
      }

      setTimeout(loadSchedule, 2000);
    }
  }

  function scheduleNextRefresh() {
    const now = new Date();
    const minutes = now.getMinutes();
    const seconds = now.getSeconds();
    const ms = now.getMilliseconds();

    const nextHalfHour = minutes < 30 ? 30 : 60;
    const minutesUntilRefresh = nextHalfHour - minutes;
    const delay = (minutesUntilRefresh * 60 * 1000) - (seconds * 1000) - ms + 8000;

    setTimeout(() => {
      loadSchedule();
      setInterval(loadSchedule, 30 * 60 * 1000);
    }, delay);
  }

  function scheduleOverlayRefresh() {
    const now = new Date();
    const seconds = now.getSeconds();
    const ms = now.getMilliseconds();
    const delay = (60 - seconds) * 1000 - ms;

    setTimeout(() => {
      refreshOpenOverlay();
      setInterval(refreshOpenOverlay, 60 * 1000);
    }, delay);
  }

  function refreshOpenOverlay() {
    const openOverlay = document.querySelector('.view-pane .pane-schedule-overlay');
    if (!openOverlay) return;

    const pane = openOverlay.parentElement;
    if (!pane) return;

    const paneIndex = paneIndexOf(pane);
    if (paneIndex === -1 || paneIndex >= paneCount) return;

    const listContainer = openOverlay.querySelector('.pane-schedule-list');

    if (listContainer) {
      const scrollPos = listContainer.scrollTop;
      listContainer.innerHTML = '';
      populateScheduleList(listContainer, pane, paneIndex);
      listContainer.scrollTop = scrollPos;
      if (isDebug()) {
        logToMain('[SCHED] minute-refresh pane ' + paneIndex + '; scheduleData=' + (scheduleData ? 'ok' : 'NULL') + '; scroll ' + scrollPos + ' -> ' + listContainer.scrollTop);
      }
    }
  }

  if (window.channelSurfer) {
    window.channelSurfer.invoke('get-schedule-path').then((p) => {
      if (p) schedulePath = p;
      loadSchedule();
    });
    window.channelSurfer.invoke('get-stream-base-urls').then((urls) => {
      if (Array.isArray(urls) && urls.length > 0) {
        streamBaseUrls = urls;
      }
    }).catch(() => {});

    window.channelSurfer.invoke('get-debug-mode').then((flag) => {
      debugMode = flag === true;
      if (debugMode) {
        logToMain('[DEBUG] renderer debug mode active');
      }
    }).catch(() => {});

    window.channelSurfer.onStreamSuccess((payload) => {
      if (!payload || typeof payload.webContentsId !== 'number') return;
      for (const attempt of streamAttempts.values()) {
        if (attempt.webContentsId === payload.webContentsId) {
          succeedStreamAttempt(attempt);
          return;
        }
      }
    });

    window.channelSurfer.onScheduleReady((payload) => {
      if (payload && typeof payload.path === 'string' && payload.path) {
        schedulePath = payload.path;
        if (!scheduleData || !isScheduleFresh(scheduleData)) {
          loadSchedule();
        }
      }
    });

    window.channelSurfer.onRecoveryPromoted((payload) => {
      if (!payload || !Array.isArray(payload.domains)) return;
      if (!pendingPromotionView) return;
      const pane = pendingPromotionView.pane;
      const domains = payload.domains;
      pendingPromotionView = null;
      if (!pane || !pane.isConnected) return;
      showRecoverySuccess(pane, domains);
    });
  } else {
    loadSchedule();
  }

  const statusScreen = document.createElement('div');
  statusScreen.id = 'guide-status-screen';
  const bodyStyle = getComputedStyle(document.body);
  const themeBg = bodyStyle.backgroundColor !== 'rgba(0, 0, 0, 0)'
    ? bodyStyle.backgroundColor
    : getComputedStyle(document.documentElement).backgroundColor;
  statusScreen.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;display:flex;align-items:center;justify-content:center;font-size:1.1rem;z-index:1000;background:' + themeBg + ';color:' + bodyStyle.color + ';';
  document.body.appendChild(statusScreen);
  guideStatusShownAt = Date.now();
  updateGuideStatusScreen();

  setContainerLayout();
  renderView();

  // Feed webview screen-space bounds to main's cursor-poll loop.
  setInterval(broadcastWebviewBounds, 500);

  scheduleNextRefresh();
  scheduleOverlayRefresh();
});

function updateAddViewButtonVisibility() {
  const btn = document.getElementById('add-view-btn');
  if (btn) btn.classList.toggle('hidden', paneCount >= 4);
}