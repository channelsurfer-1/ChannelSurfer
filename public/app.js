let scheduleData = null;
let guideUnavailableSince = Date.now();
const GUIDE_ERROR_THRESHOLD_MS = 15000;
const GUIDE_STATUS_MIN_MS = 1000;
let guideStatusShownAt = null;
let programTimers = new Map();
let currentViewMode = 'single';
let tooltipTimer = null;
let stationColumnWidth = 40;
let isResizingColumn = false;

let viewStates = {
  single: [null],
  split: [null, null],
  quad: [null, null, null, null]
};

let scheduleOverlayStates = {
  single: [false],
  split: [false, false],
  quad: [false, false, false, false]
};

let scheduleScrollPositions = {
  single: [0],
  split: [0, 0],
  quad: [0, 0, 0, 0]
};

const BASE_STREAM_URL_FALLBACK = 'https://dlive.sx/stream/stream-';
const STREAM_ATTEMPT_TIMEOUT_MS = 7000;

let streamBaseUrls = [BASE_STREAM_URL_FALLBACK];
const streamAttempts = new Map();
let debugMode = false;
const failedRecoveryCombos = new Set(); // recovery: tested-and-failed domain sets (session only)
let pendingRecoveryTest = null;         // recovery: { key, wrapper, domains } while a test retry is in flight
let pendingPromotionView = null;        // recovery: { wrapper, domains } while main runs the 60s soak

if (!document.getElementById('connecting-dots-style')) {
  const style = document.createElement('style');
  style.id = 'connecting-dots-style';
  style.textContent = `
    @keyframes dots-blink {
      0%, 100% { opacity: 1; }
      50%      { opacity: 0; }
    }
    .connecting-dots {
      animation: dots-blink 1s ease-in-out infinite;
    }
    .pane-mode-content {
      display: none;
      position: relative;
      width: 100%;
      height: 100%;
    }
    .pane-mode-content.active {
      display: block;
    }
  `;
  document.head.appendChild(style);
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

// ---------- Per-mode pane content ----------

function getPaneWrapper(pane, mode, createIfMissing) {
  const selector = ':scope > .pane-mode-content[data-mode="' + mode + '"]';
  let wrapper = pane.querySelector(selector);
  if (!wrapper && createIfMissing) {
    wrapper = document.createElement('div');
    wrapper.className = 'pane-mode-content';
    wrapper.dataset.mode = mode;
    pane.appendChild(wrapper);
  }
  return wrapper;
}

function setWrapperAudioMuted(wrapper, muted) {
  try {
    const wv = wrapper.querySelector('webview');
    if (wv) wv.setAudioMuted(muted);
  } catch (_) {}
}

function ensurePlaceholder(wrapper, pane, paneIndex) {
  if (!wrapper.querySelector('.pane-placeholder')) {
    const placeholder = document.createElement('div');
    placeholder.className = 'pane-placeholder';
    placeholder.textContent = 'Click to select a program';
    wrapper.appendChild(placeholder);
  }
  if (!wrapper.dataset.clickBound) {
    wrapper.dataset.clickBound = '1';
    wrapper.addEventListener('click', () => {
      if (viewStates[currentViewMode][paneIndex]) return;
      if (wrapper.querySelector('.pane-schedule-overlay')) return;
      showScheduleOverlay(pane, paneIndex, null);
    });
  }
}

// ---------- End per-mode pane content ----------

function updateModeButtonIcons() {
  const singleBtn = document.querySelector('[data-mode="single"]');
  if (singleBtn) {
    const isFilled = viewStates.single[0] !== null;
    singleBtn.innerHTML = isFilled
      ? '<svg width="20" height="20" viewBox="0 0 16 16"><rect x="2" y="2" width="12" height="12" fill="currentColor" stroke="currentColor" stroke-width="1.5"/></svg>'
      : '<svg width="20" height="20" viewBox="0 0 16 16"><rect x="2" y="2" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>';
  }

  const splitBtn = document.querySelector('[data-mode="split"]');
  if (splitBtn) {
    const leftFilled = viewStates.split[0] !== null;
    const rightFilled = viewStates.split[1] !== null;

    splitBtn.innerHTML = `
      <svg width="20" height="20" viewBox="0 0 16 16">
        <rect x="2" y="2" width="6" height="12" fill="${leftFilled ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.5"/>
        <rect x="8" y="2" width="6" height="12" fill="${rightFilled ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.5"/>
      </svg>`;
  }

  const quadBtn = document.querySelector('[data-mode="quad"]');
  if (quadBtn) {
    const q1Filled = viewStates.quad[0] !== null;
    const q2Filled = viewStates.quad[1] !== null;
    const q3Filled = viewStates.quad[2] !== null;
    const q4Filled = viewStates.quad[3] !== null;

    quadBtn.innerHTML = `
      <svg width="20" height="20" viewBox="0 0 16 16">
        <rect x="2" y="2" width="6" height="6" fill="${q1Filled ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.5"/>
        <rect x="8" y="2" width="6" height="6" fill="${q2Filled ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.5"/>
        <rect x="2" y="8" width="6" height="6" fill="${q3Filled ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.5"/>
        <rect x="8" y="8" width="6" height="6" fill="${q4Filled ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.5"/>
      </svg>`;
  }
}

window.setViewMode = function(mode) {
  currentViewMode = mode;

  document.querySelectorAll('.mode-button').forEach(btn => {
    btn.classList.remove('active');
  });
  const activeBtn = document.querySelector(`[data-mode="${mode}"]`);
  if (activeBtn) activeBtn.classList.add('active');

  const panesContainer = document.getElementById('panes-container');
  panesContainer.classList.remove('panes-single', 'panes-split', 'panes-quad');
  panesContainer.classList.add(`panes-${mode}`);

  renderView();
};

function getMaxPanes() {
  return currentViewMode === 'single' ? 1 : currentViewMode === 'split' ? 2 : 4;
}

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

function attachPaneLabel(wrapper, stationName, programTitle) {
  const label = document.createElement('div');
  label.className = 'pane-label';

  const logoImg = document.createElement('img');
  logoImg.className = 'pane-label-logo';
  const logoFileName = stationName.replace(/ USA$/i, '').trim();
  logoImg.src = `../images/logos/badges/${encodeURIComponent(logoFileName)}.png`;
  logoImg.onerror = function() {
    this.style.display = 'none';
  };

  const labelText = document.createElement('span');
  labelText.className = 'pane-label-text';
  labelText.textContent = programTitle;

  label.appendChild(logoImg);
  label.appendChild(labelText);
  wrapper.appendChild(label);
}

// ---------- Stream attempt failover ----------

function cancelStreamAttempt(wrapper) {
  const attempt = streamAttempts.get(wrapper);
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
  streamAttempts.delete(wrapper);
}

function cancelAllStreamAttempts() {
  for (const wrapper of Array.from(streamAttempts.keys())) {
    cancelStreamAttempt(wrapper);
  }
}

function attemptStream(pane, paneIndex, stationName, dlhdId, programTitle) {
  const wrapper = getPaneWrapper(pane, currentViewMode, true);
  cancelStreamAttempt(wrapper);
  wrapper.innerHTML = '';

  const attempt = {
    wrapper: wrapper,
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

  streamAttempts.set(wrapper, attempt);
  runStreamAttempt(attempt);
  addPaneCloseButton(wrapper, pane, paneIndex);
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
  attempt.wrapper.appendChild(webview);

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
  const dotsSpan = document.createElement('span');
  dotsSpan.className = 'connecting-dots';
  dotsSpan.textContent = '...';
  labelSpan.appendChild(dotsSpan);
  indicator.appendChild(labelSpan);
  attempt.indicator = indicator;
  attempt.wrapper.appendChild(indicator);

  const thisWebview = webview;

  webview.addEventListener('dom-ready', () => {
    if (attempt.cancelled || attempt.webview !== thisWebview) return;
    try {
      const id = thisWebview.getWebContentsId();
      attempt.webContentsId = id;
      sendIpc('register-stream-attempt', { webContentsId: id });
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
  streamAttempts.delete(attempt.wrapper);

  const elapsed = attempt.candidateStartTime
    ? ((Date.now() - attempt.candidateStartTime) / 1000).toFixed(1)
    : '?';
  logToMain(`Stream connected in ${elapsed}s (candidate ${attempt.candidateIndex + 1}/${streamBaseUrls.length})`);

  if (pendingRecoveryTest && pendingRecoveryTest.wrapper === attempt.wrapper) {
    logToMain('[RECOVERY] test PASSED, domains: ' + pendingRecoveryTest.key.split('|').join(', '));
    pendingPromotionView = { wrapper: attempt.wrapper, domains: pendingRecoveryTest.domains };
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
  attachPaneLabel(attempt.wrapper, attempt.stationName, attempt.programTitle || attempt.stationName);
}

function failStreamAttempt(attempt) {
  streamAttempts.delete(attempt.wrapper);

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
  attempt.wrapper.appendChild(failure);

  if (pendingRecoveryTest && pendingRecoveryTest.wrapper === attempt.wrapper) {
    failedRecoveryCombos.add(pendingRecoveryTest.key);
    logToMain('[RECOVERY] test failed, combo remembered: ' + pendingRecoveryTest.key.split('|').join(', '));
    sendIpc('recovery-test-result', { domains: pendingRecoveryTest.domains, passed: false });
    pendingRecoveryTest = null;
  }
  if (pendingPromotionView && pendingPromotionView.wrapper === attempt.wrapper) {
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

function showRecoverySuccess(wrapper, domains) {
  const old = wrapper.querySelector('.recovery-overlay');
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
  wrapper.appendChild(overlay);
}

// Opens the recovery dialog inside the failed pane. Debug-gated by the caller.
async function openRecoveryDialog(attempt) {
  const wrapper = attempt.wrapper;
  if (!wrapper) return;
  const old = wrapper.querySelector('.recovery-overlay');
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
  wrapper.appendChild(overlay);
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
    pendingRecoveryTest = { key, wrapper: attempt.wrapper, domains: selected };
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
    const dots = document.createElement('span');
    dots.className = 'connecting-dots';
    dots.textContent = '…';
    label.appendChild(dots);

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
  const panesContainer = document.getElementById('panes-container');
  const allPanes = panesContainer.querySelectorAll('.view-pane');
  const viewState = viewStates[currentViewMode];

  viewState.forEach((program, index) => {
    if (program && program.dlhdId === dlhdId) {
      const pane = allPanes[index];
      const wrapper = pane ? getPaneWrapper(pane, currentViewMode, false) : null;
      if (wrapper) {
        const existingLabel = wrapper.querySelector('.pane-label');
        if (existingLabel) existingLabel.remove();

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
        wrapper.appendChild(label);
      }
    }
  });
}

function renderView() {
  const panesContainer = document.getElementById('panes-container');
  const allPanes = panesContainer.querySelectorAll('.view-pane');
  const maxPanes = getMaxPanes();
  const viewState = viewStates[currentViewMode];

  allPanes.forEach((pane, index) => {
    pane.style.display = index < maxPanes ? 'block' : 'none';
  });

  for (let index = 0; index < maxPanes; index++) {
    const pane = allPanes[index];
    if (!pane) continue;
    const program = viewState[index];
    const wrapper = getPaneWrapper(pane, currentViewMode, true);

    if (program) {
      const attempt = streamAttempts.get(wrapper);
      const hasWebview = !!wrapper.querySelector('webview');
      if (!attempt && !hasWebview) {
        attemptStream(pane, index, program.stationName, program.dlhdId, program.programName);
      }
    } else {
      ensurePlaceholder(wrapper, pane, index);
    }
  }

  allPanes.forEach((pane, index) => {
    const isVisible = index < maxPanes;
    pane.querySelectorAll(':scope > .pane-mode-content').forEach(w => {
      const active = isVisible && w.dataset.mode === currentViewMode;
      w.classList.toggle('active', active);
      setWrapperAudioMuted(w, !active);
    });
  });

  if (currentViewMode === 'single' && !viewState[0] && scheduleData) {
    showScheduleOverlay(allPanes[0], 0, null);
    updateModeButtonIcons();
    return;
  }

  scheduleOverlayStates[currentViewMode].forEach((isOpen, index) => {
    if (isOpen && index < maxPanes) {
      const pane = allPanes[index];
      if (!pane) return;
      const wrapper = getPaneWrapper(pane, currentViewMode, false);
      if (wrapper && !wrapper.querySelector('.pane-schedule-overlay')) {
        showScheduleOverlay(pane, index, viewState[index] || null);
      }
    }
  });

  updateModeButtonIcons();
}

function showScheduleOverlay(pane, paneIndex, existingProgram) {
  const panesContainer = document.getElementById('panes-container');
  const allPanes = panesContainer.querySelectorAll('.view-pane');
  const maxPanes = getMaxPanes();

  allPanes.forEach((otherPane, index) => {
    if (otherPane === pane || index >= maxPanes) return;
    const otherWrapper = getPaneWrapper(otherPane, currentViewMode, false);
    if (!otherWrapper) return;

    const otherOverlay = otherWrapper.querySelector('.pane-schedule-overlay');
    if (otherOverlay) {
      const otherListContainer = otherOverlay.querySelector('.pane-schedule-list');
      if (otherListContainer) {
        if (isDebug()) {
          logToMain('[SCHED] save scroll pane ' + index + ' (other-close): ' + otherListContainer.scrollTop + ' (store was ' + scheduleScrollPositions[currentViewMode][index] + ')');
        }
        scheduleScrollPositions[currentViewMode][index] = otherListContainer.scrollTop;
      }

      otherOverlay.remove();
      scheduleOverlayStates[currentViewMode][index] = false;

      const otherProgram = viewStates[currentViewMode][index];
      if (otherProgram) {
        const existingWebview = otherWrapper.querySelector('webview');
        if (existingWebview) {
          existingWebview.style.display = '';
        }

        if (!otherWrapper.querySelector('.pane-label') && otherProgram.programName) {
          const label = document.createElement('div');
          label.className = 'pane-label';

          const logoImg = document.createElement('img');
          logoImg.className = 'pane-label-logo';
          const logoFileName = otherProgram.stationName.replace(/ USA$/i, '').trim();
          logoImg.src = `../images/logos/badges/${encodeURIComponent(logoFileName)}.png`;
          logoImg.onerror = function() {
            this.style.display = 'none';
          };

          const labelText = document.createElement('span');
          labelText.className = 'pane-label-text';
          labelText.textContent = otherProgram.programName;

          label.appendChild(logoImg);
          label.appendChild(labelText);
          otherWrapper.appendChild(label);
        }
      } else {
        ensurePlaceholder(otherWrapper, otherPane, index);
      }
    }
  });

  const wrapper = getPaneWrapper(pane, currentViewMode, true);
  scheduleOverlayStates[currentViewMode][paneIndex] = true;

  const existingOverlay = wrapper.querySelector('.pane-schedule-overlay');
  if (existingOverlay) {
    const existingListContainer = existingOverlay.querySelector('.pane-schedule-list');
    if (existingListContainer) {
      if (isDebug()) {
        logToMain('[SCHED] save scroll pane ' + paneIndex + ' (reopen): ' + existingListContainer.scrollTop + ' (store was ' + scheduleScrollPositions[currentViewMode][paneIndex] + ')');
      }
      scheduleScrollPositions[currentViewMode][paneIndex] = existingListContainer.scrollTop;
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

  wrapper.appendChild(overlay);

  populateScheduleList(listContainer, pane, paneIndex);

  listContainer.scrollTop = scheduleScrollPositions[currentViewMode][paneIndex] || 0;
  if (isDebug()) {
    logToMain('[SCHED] restore scroll pane ' + paneIndex + ': ' + listContainer.scrollTop);
  }

  updateModeButtonIcons();
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
      const dotsSpan = document.createElement('span');
      dotsSpan.className = 'connecting-dots';
      dotsSpan.textContent = '…';
      labelSpan.appendChild(dotsSpan);
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

    row.dataset.tooltipTitle = programTitle;
    row.dataset.tooltipDesc = programDescription;
    row.addEventListener('mouseenter', showTooltip);
    row.addEventListener('mousemove', moveTooltip);
    row.addEventListener('mouseleave', hideTooltip);

    row.addEventListener('click', (e) => {
      if (isResizingColumn) return;

      e.stopPropagation();

      hideTooltip();

      const modeWrapper = getPaneWrapper(pane, currentViewMode, false);
      const currentList = modeWrapper ? modeWrapper.querySelector('.pane-schedule-list') : null;
      if (currentList) {
        if (isDebug()) {
          logToMain('[SCHED] save scroll pane ' + paneIndex + ' (row-click, mode=' + currentViewMode + '): ' + currentList.scrollTop);
        }
        scheduleScrollPositions[currentViewMode][paneIndex] = currentList.scrollTop;
      }

      viewStates[currentViewMode][paneIndex] = {
        stationName: displayName,
        dlhdId: stationObj.dlhdId,
        programName: programTitle
      };

      scheduleOverlayStates[currentViewMode][paneIndex] = false;

      scheduleProgramTimer(stationObj.dlhdId);

      updateModeButtonIcons();

      attemptStream(pane, paneIndex, displayName, stationObj.dlhdId, programTitle);
    });

    listContainer.appendChild(row);
  });
}

function addPaneCloseButton(wrapper, pane, paneIndex) {
  const closeBtn = document.createElement('button');
  closeBtn.className = 'pane-close-btn';
  closeBtn.innerHTML = '&times;';
  closeBtn.title = 'Close stream';

  closeBtn.addEventListener('click', (e) => {
    e.stopPropagation();

    cancelStreamAttempt(wrapper);

    viewStates[currentViewMode][paneIndex] = null;
    scheduleOverlayStates[currentViewMode][paneIndex] = false;
    updateModeButtonIcons();

    wrapper.innerHTML = '';

    showScheduleOverlay(pane, paneIndex, null);
  });

  wrapper.appendChild(closeBtn);
}

document.addEventListener('DOMContentLoaded', () => {
  let schedulePath = '../data/schedule.json';

  document.querySelectorAll('.mode-button').forEach(btn => {
    btn.addEventListener('click', () => setViewMode(btn.dataset.mode));
  });

  document.addEventListener('click', (e) => {
    if (isResizingColumn) {
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
      const startWidthPercent = stationColumnWidth;

      const onMouseMove = (moveEvent) => {
        const overlay = document.querySelector('.pane-schedule-overlay');
        if (!overlay) return;

        const overlayWidth = overlay.offsetWidth;
        const deltaX = moveEvent.clientX - startX;
        const deltaPercent = (deltaX / overlayWidth) * 100;
        const newWidth = startWidthPercent + deltaPercent;

        if (newWidth >= 20 && newWidth <= 60) {
          stationColumnWidth = newWidth;
          document.querySelectorAll('.pane-schedule-station').forEach(station => {
            station.style.width = newWidth + '%';
            station.style.minWidth = newWidth + '%';
          });
        }
      };

      const onMouseUp = () => {
        isResizingColumn = false;
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

      Object.values(viewStates).forEach(state => {
        state.forEach(program => {
          if (program) {
            const info = getCurrentProgramInfo(program.dlhdId);
            if (info) {
              updatePaneLabel(program.dlhdId, info.programName);
            }
            scheduleProgramTimer(program.dlhdId);
          }
        });
      });

      updateModeButtonIcons();
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
    const openOverlay = document.querySelector('.pane-schedule-overlay');
    if (!openOverlay) return;

    const wrapper = openOverlay.parentElement;
    const pane = wrapper ? wrapper.parentElement : null;
    if (!pane) return;

    const panesContainer = document.getElementById('panes-container');
    const paneIndex = Array.from(panesContainer.querySelectorAll('.view-pane')).indexOf(pane);

    const listContainer = openOverlay.querySelector('.pane-schedule-list');

    if (listContainer && paneIndex !== -1) {
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
      const wrapper = pendingPromotionView.wrapper;
      const domains = payload.domains;
      pendingPromotionView = null;
      if (!wrapper || !wrapper.isConnected) return;
      showRecoverySuccess(wrapper, domains);
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

  renderView();

  scheduleNextRefresh();
  scheduleOverlayRefresh();
});
