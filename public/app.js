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
// Per-pane guide filter (10-05): the raw query string. Read at render time
// by populateScheduleList, so reopen, the 60s refresh, and schedule rollover
// all re-derive matches from current data. Restored with the input visibly
// populated; travels with the pane on drag-swap like every index-mapped state.
let paneFilter = [''];

const BASE_STREAM_URL_FALLBACK = 'https://dlive.sx/stream/stream-';
const STREAM_ATTEMPT_TIMEOUT_MS = 7000;

let streamBaseUrls = [BASE_STREAM_URL_FALLBACK];
const streamAttempts = new Map(); // pane element -> attempt
let debugMode = false;
const failedRecoveryCombos = new Set(); // recovery: tested-and-failed domain sets (session only)
let pendingRecoveryTest = null;         // recovery: { key, pane, domains } while a test retry is in flight
let pendingPromotionView = null;        // recovery: { pane, domains } while main runs the 60s soak

// Playback stall watchdog (09-26): main samples each connected stream's
// player frame every 2s and reports here; a pane whose currentTime stops
// advancing while un-paused (and no failover is in flight) is re-streamed.
// Catches the frozen-video desync class; the smooth-picture/audio-only
// class is undetectable from outside the guest (guest-side DSP declined).
const STALL_TIMEOUT_MS = 10000;
const paneHealth = new Map(); // webContentsId -> { lastTime, lastProgressAt, alerted }

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

// Slot↔div mapping model (09-26): every .view-pane div carries a data-pane
// attribute = the slot it currently fills. Slots 0..paneCount-1 are visible;
// higher-numbered divs are parked (emptied). Closing a slot bumps survivors'
// attributes down instead of moving their contents — moving a webview's
// element kills the guest (Spike 1) — so survivors keep playing with NO
// re-stream. Visual placement follows data-pane via CSS order/grid, never
// DOM order. allPanes() returns divs sorted by slot, so slot-indexed logic
// throughout this file is unchanged.
function allPanes() {
  const panesContainer = document.getElementById('panes-container');
  return Array.from(panesContainer.querySelectorAll('.view-pane'))
    .sort((a, b) => (Number(a.dataset.pane) || 0) - (Number(b.dataset.pane) || 0));
}

function getPane(index) {
  return allPanes()[index] || null;
}

function paneIndexOf(pane) {
  const slot = Number(pane.dataset.pane);
  return Number.isInteger(slot) ? slot : -1;
}

function setContainerLayout() {
  const panesContainer = document.getElementById('panes-container');
  panesContainer.classList.remove('panes-1', 'panes-2', 'panes-3', 'panes-4');
  panesContainer.classList.add('panes-' + paneCount);
}

function applyPaneVisibility() {
  allPanes().forEach((pane) => {
    const slot = Number(pane.dataset.pane);
    pane.style.display = slot < paneCount ? '' : 'none';
  });
}

function applyFocusStyles() {
  allPanes().forEach((pane) => {
    const slot = Number(pane.dataset.pane);
    pane.classList.toggle('focused', slot < paneCount && slot === focusedPaneIndex);
  });
}

function countActivePanes() {
  return panePrograms.filter(Boolean).length;
}

function applyAudioState() {
  allPanes().forEach((pane) => {
    const index = Number(pane.dataset.pane);
    if (index >= paneCount) return;
    const guideOpen = !!pane.querySelector('.pane-schedule-overlay');
    const gripBtn = pane.querySelector('.pane-grip-btn');
    if (gripBtn) {
      // Swap needs a partner: this pane occupied, another occupied pane
      // exists, and no guide is covering this one.
      gripBtn.style.display = (panePrograms[index] && countActivePanes() >= 2 && !guideOpen) ? '' : 'none';
    }
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
      // isn't covering this one. Radio-group semantics: the SAME speaker
      // glyph sits on every pane and color alone carries the selection
      // (accent = the audio source; grey = click to move audio here).
      // This chooses WHICH pane you hear — it is not a per-pane mute;
      // muting lives in the player's own control bar.
      const active = (index === focusedPaneIndex);
      soundBtn.style.display = (paneCount > 1 && !guideOpen) ? '' : 'none';
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
  // The div parked at data-pane === paneCount becomes the new slot
  // automatically when the count increments — no assignment needed.
  paneCount++;
  panePrograms.push(null);
  paneOverlayOpen.push(false);
  paneScroll.push(0);
  const newPane = getPane(paneCount - 1);
  if (newPane) newPane.innerHTML = ''; // parked divs are emptied by the
                                       // renderView invariant; belt-and-braces.
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
    pendingFocusPane = -1;
    focusPane(0);
    renderView();
    return;
  }

  panePrograms.splice(index, 1);
  paneOverlayOpen.splice(index, 1);
  paneScroll.splice(index, 1);
  paneCount--;

  // Slot remap: survivors below the closed slot move down one (data-pane
  // bump); the closed div parks at the freed top number. No re-streams.
  allPanes().forEach((p) => {
    const slot = Number(p.dataset.pane);
    if (slot > index) p.dataset.pane = String(slot - 1);
  });
  pane.dataset.pane = String(paneCount);

  if (focusedPaneIndex > index) focusedPaneIndex--;
  else if (focusedPaneIndex === index) focusedPaneIndex = Math.min(index, paneCount - 1);

  // pendingFocusPane is the same kind of live index as focusedPaneIndex and
  // must survive the splice-and-remap the same way. A pending focus on the
  // closed slot is dropped (the pane is gone; a future pane landing there
  // must not inherit the request). A pending focus at a higher index shifts
  // down one to keep pointing at its pane.
  if (pendingFocusPane === index) pendingFocusPane = -1;
  else if (pendingFocusPane > index) pendingFocusPane--;

  setContainerLayout();
  renderView();
  if (isDebug()) {
    logToMain('[VIEW] closed pane ' + (index + 1) + '; paneCount=' + paneCount);
  }
}

// ---------- Pane drag-swap (09-27) ----------
// Initiated from each pane's grip handle — the video surface can't receive
// the grab (mousedown over a webview routes to the guest). On drop, the
// two panes' SLOTS exchange: data-pane attributes, state-array entries,
// and focus. The divs (and their webviews, overlays, labels) never move —
// moving a webview kills the guest (Spike 1). The data-pane remap model
// re-places them visually; renderView finds each slot's channel-matching
// webview already in the right div, so a swap NEVER re-streams.
// Occupied panes only, and a pane with its schedule open is out of the
// swap game in BOTH directions (swapping would teleport a live browsing
// session).
let dragSourceSlot = -1;
let dragActive = false;
// Active drag's cursor-stream callback (registered once at boot, routed here).
let dragCursorHandler = null;

function paneSlotAtPoint(x, y) {
  for (const pane of allPanes()) {
    const slot = Number(pane.dataset.pane);
    if (slot >= paneCount || slot === dragSourceSlot) continue;
    if (!panePrograms[slot]) continue; // occupied panes only
    // A pane with its schedule open is out of the swap game (both
    // directions): swapping would teleport a live browsing session.
    if (pane.querySelector('.pane-schedule-overlay')) continue;
    const r = pane.getBoundingClientRect();
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return slot;
  }
  return -1;
}

function startPaneDrag(slot, startX, startY) {
  // Cursor-poll drag (09-27): the host renderer is blind to mouse events
  // over webview guests, so document mousemove cannot track a drag that
  // crosses video surfaces. Main streams OS cursor points (10 Hz) while
  // the drag is armed; drop = cursor still for DROP_STILLNESS_MS, a
  // mouseup that reaches host chrome, or Escape to cancel.
  dragSourceSlot = slot;
  dragActive = false;
  let lastTarget = -1;
  let watchdogTimer = null;
  let armTimer = null;
  let lastX = 0;
  let lastY = 0;
  let lastChangeAt = 0;
  const sourcePane = getPane(slot);
  const DROP_STILLNESS_MS = 800;

  const toClient = (sx, sy) => ({ x: sx - window.screenX, y: sy - window.screenY });

  const finish = (commit) => {
    if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null; }
    if (armTimer) { clearTimeout(armTimer); armTimer = null; }
    document.removeEventListener('mouseup', onUpDoc, true);
    document.removeEventListener('keydown', onKey, true);
    sendIpc('drag-arm', { armed: false });
    document.body.style.cursor = 'default';
    if (sourcePane) sourcePane.classList.remove('pane-drag-source');
    if (lastTarget !== -1) {
      const p = getPane(lastTarget);
      if (p) p.classList.remove('pane-drag-target');
    }
    if (commit && dragActive && lastTarget !== -1 && lastTarget !== slot) {
      swapPaneSlots(slot, lastTarget);
    }
    dragActive = false;
    dragSourceSlot = -1;
    dragCursorHandler = null;
  };

  const onCursor = (payload) => {
    if (!payload || typeof payload.x !== 'number') return;
    // Payload is already content-relative (converted in main).
    const c = { x: payload.x, y: payload.y };
    if (!dragActive) {
      if (Math.abs(c.x - startX) <= 4 && Math.abs(c.y - startY) <= 4) {
        return; // merely armed, still aiming — stillness only applies to a real drag
      }
      dragActive = true;
      document.body.style.cursor = 'grabbing';
      if (sourcePane) sourcePane.classList.add('pane-drag-source');
      lastX = c.x; lastY = c.y; lastChangeAt = Date.now();
      // Position-based stillness: the stream keeps ticking at 10 Hz while
      // the cursor is stationary, so silence can never be observed (each
      // tick resets a silence timer — bug 09-27). A watchdog measures how
      // long the POSITION has been unchanged instead.
      watchdogTimer = setInterval(() => {
        if (Date.now() - lastChangeAt > DROP_STILLNESS_MS) finish(true);
      }, 200);
    } else if (Math.abs(c.x - lastX) > 2 || Math.abs(c.y - lastY) > 2) {
      lastX = c.x; lastY = c.y; lastChangeAt = Date.now();
    }
    const target = paneSlotAtPoint(c.x, c.y);
    if (target !== lastTarget) {
      if (lastTarget !== -1) {
        const p = getPane(lastTarget);
        if (p) p.classList.remove('pane-drag-target');
      }
      if (target !== -1) {
        const p = getPane(target);
        if (p) p.classList.add('pane-drag-target');
      }
      lastTarget = target;
    }
  };

  const onUpDoc = () => finish(true);
  const onKey = (e) => { if (e.key === 'Escape') finish(false); };

  dragCursorHandler = onCursor;
  sendIpc('drag-arm', { armed: true });
  document.addEventListener('mouseup', onUpDoc, true);
  document.addEventListener('keydown', onKey, true);
  // No stillness clock while merely armed — pressing the grip and studying
  // the screen must not cancel the drag (bug 09-27: a 600ms hesitation
  // disarmed before movement began). A 10s fuse guards a lost mouseup.
  armTimer = setTimeout(() => finish(false), 10000);
}

function swapPaneSlots(a, b) {
  if (a === b) return;
  const paneA = getPane(a);
  const paneB = getPane(b);
  if (!paneA || !paneB) return;

  // Exchange slot assignments only — contents never move.
  paneA.dataset.pane = String(b);
  paneB.dataset.pane = String(a);

  const swapArr = (arr) => { const t = arr[a]; arr[a] = arr[b]; arr[b] = t; };
  swapArr(panePrograms);
  swapArr(paneOverlayOpen);
  swapArr(paneScroll);

  if (focusedPaneIndex === a) focusedPaneIndex = b;
  else if (focusedPaneIndex === b) focusedPaneIndex = a;
  // pendingFocusPane is the same kind of live index as focusedPaneIndex --
  // per the handoff rule, every index-like variable gets the same
  // maintenance. A connect designated for slot a must land in b after the
  // swap and vice versa; a stale value steals focus onto the wrong pane
  // when the stream connects.
  if (pendingFocusPane === a) pendingFocusPane = b;
  else if (pendingFocusPane === b) pendingFocusPane = a;

  renderView();
  if (isDebug()) {
    logToMain('[VIEW] swapped panes ' + (a + 1) + ' <-> ' + (b + 1));
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
  guideBtn.innerHTML = '<svg viewBox="0 0 25 25" width="14" height="14" fill="currentColor" aria-hidden="true"><rect x="7" y="0.5" width="1.6" height="3" rx="0.8"/><rect x="16.4" y="0.5" width="1.6" height="3" rx="0.8"/><path fill-rule="evenodd" d="M4.5 3.5 h16 a2.5 2.5 0 0 1 2.5 2.5 v14.5 a2.5 2.5 0 0 1 -2.5 2.5 h-16 a2.5 2.5 0 0 1 -2.5 -2.5 V6 a2.5 2.5 0 0 1 2.5 -2.5 Z M4 5.5 h17 v15.5 h-17 Z"/><rect x="5.5" y="9.6" width="14" height="2.8" rx="1.4"/><rect x="5.5" y="14.1" width="14" height="2.8" rx="1.4"/></svg>';
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

  // Speaker button: one plain glyph on every pane (no waves, no slash —
  // no per-pane on/off state is implied). applyAudioState colors it:
  // accent = the pane you hear, grey = click to move the audio here.
  const soundBtn = document.createElement('button');
  soundBtn.className = 'pane-sound-btn';
  soundBtn.title = 'Play audio from this view';
  soundBtn.innerHTML = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M3 6h2.5L9 3v10L5.5 10H3z" stroke-linejoin="round"/></svg>';
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

  // Drag grip: initiates pane drag-swap (the video surface can't receive
  // the grab — mousedown over a webview routes to the guest). Four arrows
  // = "move". Visibility (applyAudioState): only when this pane is
  // occupied AND at least one other occupied pane exists (a swap needs a
  // partner) AND this pane's own guide isn't open.
  const gripBtn = document.createElement('button');
  gripBtn.className = 'pane-grip-btn';
  gripBtn.title = 'Drag onto another pane to swap';
  gripBtn.innerHTML = '<svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true"><g stroke="currentColor" stroke-width="1.1" stroke-linecap="round" fill="none"><line x1="8" y1="5.3" x2="8" y2="10.7"/><line x1="5.3" y1="8" x2="10.7" y2="8"/></g><g fill="currentColor"><path d="M8 2.7L6.4 5.3 9.6 5.3Z"/><path d="M8 13.3L6.4 10.7 9.6 10.7Z"/><path d="M2.7 8L5.3 6.4 5.3 9.6Z"/><path d="M13.3 8L10.7 6.4 10.7 9.6Z"/></g></svg>';
  gripBtn.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const slot = paneIndexOf(pane);
    if (slot === -1 || slot >= paneCount) return;
    if (!panePrograms[slot]) return; // occupied panes only
    startPaneDrag(slot, e.clientX, e.clientY);
  });

  controls.appendChild(gripBtn);
  controls.appendChild(soundBtn);
  controls.appendChild(guideBtn);
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

  // Fullscreen audio policy: entering fullscreen makes this pane the audio
  // focus (you're watching it); leaving restores the previous focus — but
  // only if focus is still on this pane (the fixed webview covers all
  // controls while fullscreen, so focus can't move; the guard is
  // belt-and-braces).
  let prevFocusOnFullscreen = -1;

  webview.addEventListener('enter-html-full-screen', () => {
    webview.style.position = 'fixed';
    webview.style.top = '0';
    webview.style.left = '0';
    webview.style.width = '100vw';
    webview.style.height = '100vh';
    webview.style.zIndex = '9999';
    const pane = webview.parentElement;
    const idx = pane ? paneIndexOf(pane) : -1;
    if (idx !== -1 && idx < paneCount) {
      prevFocusOnFullscreen = focusedPaneIndex;
      focusPane(idx);
    }
  });

  webview.addEventListener('leave-html-full-screen', () => {
    webview.style.position = '';
    webview.style.top = '';
    webview.style.left = '';
    webview.style.width = '';
    webview.style.height = '';
    webview.style.zIndex = '';
    const pane = webview.parentElement;
    const idx = pane ? paneIndexOf(pane) : -1;
    if (idx !== -1 && prevFocusOnFullscreen !== -1 && focusedPaneIndex === idx) {
      focusPane(prevFocusOnFullscreen);
    }
    prevFocusOnFullscreen = -1;
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
    sendIpc('unregister-health', { webContentsId: attempt.webContentsId });
    paneHealth.delete(attempt.webContentsId);
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
  indicator.style.fontSize = '1.25rem'; // pairs with the centered "Loading schedule" status screen (10-11)
  indicator.style.zIndex = '100';
  // Status display only — never eat clicks. At z-100 this overlay used to
  // sit above the corner buttons (z-60), making × and the calendar dead
  // while connecting: the pane ignored close/guide clicks for the whole
  // failover window (09-27).
  indicator.style.pointerEvents = 'none';
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
  // Slots may have remapped (pane closed) while this attempt was in
  // flight — re-derive the slot from the element, not the cached index.
  attempt.paneIndex = paneIndexOf(attempt.pane);

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
  // Same re-derivation as succeedStreamAttempt — slots may have remapped.
  attempt.paneIndex = paneIndexOf(attempt.pane);
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
    // Write-on-pass rollback: the recovered stream died inside the soak
    // window — tell main to remove the just-saved domains everywhere.
    sendIpc('recovery-soak-failed', { domains: pendingPromotionView.domains });
    logToMain('[RECOVERY] playback failed during soak; rolled back: ' + pendingPromotionView.domains.join(', '));
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
  sub.textContent = domains.join(', ') + ' saved to your local config — kept if playback holds for 60s, removed automatically if the stream fails.';
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

  // Rev 6 (10-05): the above/left flips had no guard on the far edge, so a
  // tooltip taller/wider than ~half the viewport could land with negative
  // top/left and get clipped. Clamp inside the window.
  if (top < 10) top = 10;
  if (left < 10) left = 10;

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
    label.textContent = 'Unable to load schedule...';
  } else {
    label.textContent = 'Loading schedule';
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
  allPanes().forEach((pane) => {
    const index = Number(pane.dataset.pane);
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

  // Reconciliation invariant: visible slot i (div with data-pane === i)
  // shows panePrograms[i]; parked divs (data-pane >= paneCount) are empty.
  // A survivor left playing in a parked div would make invisible ghost
  // audio — tear it down. Webviews are never moved between divs: slots
  // remap by data-pane, so a displaced survivor needs no re-stream.
  allPanes().forEach((pane) => {
    const slot = Number(pane.dataset.pane);
    if (slot >= paneCount && pane.firstChild) {
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
      // Only a channel match proves this div is showing the program the
      // slot calls for. Otherwise tear down and re-stream (attemptStream
      // replaces whatever is in the pane).
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

  // Pane count/layout changes resize the overlay's list too - re-pin.
  syncAllOverlayDividers();
}

function showScheduleOverlay(pane, paneIndex, existingProgram) {
  // One overlay at a time, app-wide: opening one closes the others.
  allPanes().forEach((otherPane) => {
    const index = Number(otherPane.dataset.pane);
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
  programHeader.appendChild(buildScheduleFilter(pane, overlay, paneIndex));

  overlay.appendChild(header);

  const listContainer = document.createElement('div');
  listContainer.className = 'pane-schedule-list';
  overlay.appendChild(listContainer);

  pane.appendChild(overlay);

  populateScheduleList(listContainer, pane, paneIndex);

  // Pin header + every row divider to the same px - see syncOverlayDividers.
  syncOverlayDividers(overlay);

  listContainer.scrollTop = paneScroll[paneIndex] || 0;
  if (isDebug()) {
    logToMain('[SCHED] restore scroll pane ' + paneIndex + ': ' + listContainer.scrollTop);
  }

  // The overlay now exists; refresh button visibility (the guide button
  // hides itself while its guide is open; the × hides on empty-pane
  // guides and in single view).
  applyAudioState();
}

// ---------- Guide filter (10-05, rev 2) ----------
// One input per guide, embedded at the right end of the Program header
// cell. The query lives in paneFilter[idx]; the list re-renders from
// populateScheduleList, which is the single place that applies the filter —
// so the 60s refresh and any reopen re-apply it with zero extra machinery.
// Pane index is re-derived at event time (slot remaps must not strand a
// stale index).
function buildScheduleFilter(pane, overlay, paneIndex) {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'pane-schedule-filter';
    input.placeholder = 'Filter by station or program…';
    input.spellcheck = false;
    input.value = paneFilter[paneIndex] || '';

    const applyFilter = () => {
        const idx = paneIndexOf(pane);
        if (idx === -1 || idx >= paneCount) return;
        paneFilter[idx] = input.value;
        const list = overlay.querySelector('.pane-schedule-list');
        if (!list) return;
        list.innerHTML = '';
        populateScheduleList(list, pane, idx);
        list.scrollTop = 0; // reshaped list — scroll restore is meaningless
    };

    input.addEventListener('input', (evt) => {
        // Balloon reset (rev 5, 10-05): filtering can remove the hovered row
        // without the browser ever firing mouseleave, so the balloon's only
        // dismissal path never runs. Synthesize it. No-op when nothing is
        // hovered; balloon stays gone until the next real mouse move.
        const hoverChain = document.querySelectorAll(':hover');
        const hovered = hoverChain[hoverChain.length - 1];
        if (hovered) {
            for (const type of ['mouseleave', 'mouseout', 'pointerleave', 'pointerout']) {
                hovered.dispatchEvent(new MouseEvent(type, { bubbles: true }));
            }
        }
        applyFilter(evt);
    });

    // Escape ladder unchanged: text present -> clear it, keep the guide
    // open, swallow the key. Empty -> bubble; the document handler closes
    // the guide. All other keys swallowed so host shortcuts can't fire.
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            if (input.value.trim() !== '') {
                e.stopPropagation();
                input.value = '';
                applyFilter();
            }
        } else {
            e.stopPropagation();
        }
    });

    // Right-edge placement (10-05, rev 4): anchor to the column's BORDER
    // edge, not its content edge. Rev 3 subtracted the cell's padding,
    // which left that padding visible as a permanent gap. With no ×
    // (single-pane), cancel the padding with an equal negative margin —
    // truly flush. With a ×, stop 6px short of it, as before.
    requestAnimationFrame(() => {
      const cell = overlay.querySelector('.pane-schedule-header-program');
      if (!cell) return;
      const pad = parseFloat(getComputedStyle(cell).paddingRight) || 0;
      const closeBtn = pane.querySelector('.pane-close-btn');
      const closeRect = closeBtn ? closeBtn.getBoundingClientRect() : null;
      if (closeRect && closeRect.width > 0) {
        // × visible over the header: stop 6px short of its left edge.
        const cellRight = cell.getBoundingClientRect().right - pad;
        input.style.marginRight = Math.max(0, cellRight - closeRect.left + 6) + 'px';
      } else {
        // × hidden (single EMPTY pane): flush to the border, padding cancelled.
        input.style.marginRight = (6 - pad) + 'px';
      }
    });

    return input;
}

function populateScheduleList(listContainer, pane, paneIndex) {
    if (!scheduleData || !scheduleData.stations) {
        const msgRow = document.createElement('div');
        msgRow.className = 'pane-schedule-row';
        msgRow.style.cssText = 'color:#999;font-size:13px;padding:14px 12px;';
        const unavailableMs = guideUnavailableSince ? Date.now() - guideUnavailableSince : 0;
        if (unavailableMs >= GUIDE_ERROR_THRESHOLD_MS) {
            msgRow.textContent = "Can't load schedule.";
        } else {
            const labelSpan = document.createElement('span');
            labelSpan.textContent = 'Loading schedule';
            labelSpan.appendChild(makeConnectingDots());
            msgRow.appendChild(labelSpan);
            const remaining = GUIDE_ERROR_THRESHOLD_MS - unavailableMs;
            if (remaining > 0) {
                setTimeout(() => {
                    if (msgRow.isConnected && !scheduleData) {
                        msgRow.textContent = "Can't load schedule.";
                    }
                }, remaining);
            }
        }
        listContainer.appendChild(msgRow);
        return;
    }
    const nowMs = Date.now();
    // Filter (10-05): case-insensitive literal substring against the station
    // display name OR the current program title. Empty = no filter. The
    // stored query is re-applied on every render (refresh/reopen/rollover).
    const rawNeedle = (paneFilter[paneIndex] || '').trim();
    const needle = rawNeedle.toLowerCase();
    const stationsEntries = Object.entries(scheduleData.stations);
    stationsEntries.sort((a, b) => a[0].localeCompare(b[0]));
    stationsEntries.forEach(([stationName, stationObj]) => {
        const displayName = stationName.replace(/ USA$/i, '').trim();
        // Program title/description are needed for the filter test, so they
        // are computed before any row DOM is built (was mid-build; hoisted).
        const slots = stationObj.slots || [];
        const currentSlot = slots.find(s => nowMs >= s.startMs && nowMs < s.stopMs);
        let programTitle = '';
        let programDescription = 'No description available';
        if (currentSlot) {
            const textarea = document.createElement('textarea');
            textarea.innerHTML = currentSlot.program;
            programTitle = textarea.value;
            if (currentSlot.description) {
                const descTextarea = document.createElement('textarea');
                descTextarea.innerHTML = currentSlot.description;
                programDescription = descTextarea.value;
            }
        }
        if (needle) {
            const matches = displayName.toLowerCase().includes(needle)
                || programTitle.toLowerCase().includes(needle);
            if (!matches) return;
        }
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
        const logoImg = document.createElement('img');
        logoImg.className = 'pane-schedule-logo';
        const logoFileName = stationName.replace(/ USA$/i, '').trim();
        logoImg.src = `../images/logos/badges/${encodeURIComponent(logoFileName)}.png`;
        logoImg.alt = displayName;
        logoImg.onerror = function() { this.style.display = 'none'; };
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
        if (currentSlot) {
            programSpan.textContent = programTitle;
            programSpan.classList.add('is-live');
        } else {
            programSpan.textContent = 'No program data';
        }
        row.appendChild(programSpan);
        programSpan.dataset.tooltipTitle = programTitle;
        programSpan.dataset.tooltipDesc = programDescription;
        programSpan.addEventListener('mouseenter', showTooltip);
        programSpan.addEventListener('mousemove', moveTooltip);
        programSpan.addEventListener('mouseleave', hideTooltip);
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
            const alreadyPlaying = currentProgram && currentProgram.dlhdId === stationObj.dlhdId && !streamAttempts.has(pane) && wv && !wv.dataset.dead && wv.dataset.channelId === String(stationObj.dlhdId);
            if (alreadyPlaying) {
                const overlay = pane.querySelector('.pane-schedule-overlay');
                if (overlay) overlay.remove();
                paneOverlayOpen[paneIndex] = false;
                applyAudioState();
                return;
            }
            panePrograms[paneIndex] = { stationName: displayName, dlhdId: stationObj.dlhdId, programName: programTitle };
            paneOverlayOpen[paneIndex] = false;
            scheduleProgramTimer(stationObj.dlhdId);
            pendingFocusPane = paneIndex;
            attemptStream(pane, paneIndex, displayName, stationObj.dlhdId, programTitle);
        });
        listContainer.appendChild(row);
    });
    // Zero matches: never a blank guide. textContent only — the needle is
    // echoed unescaped-safe.
    if (needle && listContainer.children.length === 0) {
        const emptyRow = document.createElement('div');
        emptyRow.className = 'pane-schedule-empty';
        emptyRow.textContent = 'No matches for "' + rawNeedle + '"';
        listContainer.appendChild(emptyRow);
    }    
    // Rev 7 (10-05): rebuilt rows take CSS-default widths from the list's
    // CURRENT geometry, but the header keeps the divider widths the last
    // sync pinned (init-time). Any scrollbar change since — filtering is
    // the visible case; the 60s refresh and reopen can do it too — leaves
    // header and rows on different geometries. Re-derive both after every
    // rebuild. (Init's own sync at the call site is idempotent; harmless.)
    const overlay = listContainer.closest('.pane-schedule-overlay');
    if (overlay) syncOverlayDividers(overlay);
}

document.addEventListener('DOMContentLoaded', () => {
  // Hide the raw-HTML skeleton (empty pane + border strips) that
  // paints before the renderer builds the panes; revealed by CSS.
  document.body.classList.add('booted');
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
    hideTooltip();
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
    // Tooltip teardown (10-04 pattern): the rebuild below empties the list
    // with innerHTML = '', which detaches the hovered row without firing
    // mouseleave — the balloon would float until the next real mouse move.
    hideTooltip();

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
    // Remote-first: only a path main already generated (it beat us to it)
    // loads immediately. '' means the fresh download is still in flight —
    // wait for schedule-ready instead of showing a same-day-but-old local file.
    window.channelSurfer.invoke('get-schedule-path').then((p) => {
      if (p) {
        schedulePath = p;
        loadSchedule();
      }
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

    // Stall watchdog: see paneHealth declaration above. Only the
    // frozen-video class is detectable this way; paused (idle triangle)
    // and buffering states are excluded on purpose.
    window.channelSurfer.onStreamHealth((payload) => {
      if (!payload || typeof payload.webContentsId !== 'number' || !payload.available) return;

      let pane = null;
      for (const p of allPanes()) {
        const wv = p.querySelector('webview');
        if (!wv) continue;
        try { if (wv.getWebContentsId() === payload.webContentsId) { pane = p; break; } } catch (_) {}
      }
      if (!pane) return;
      const slot = paneIndexOf(pane);
      if (slot === -1 || slot >= paneCount) return;
      if (streamAttempts.has(pane)) return;    // failover window — not a stall
      if (!panePrograms[slot]) return;         // nothing expected in this slot
      if (payload.paused || payload.readyState < 2) return; // paused/buffering excluded

      const now = Date.now();
      const h = paneHealth.get(payload.webContentsId) || { lastTime: -1, lastProgressAt: now, alerted: false };
      if (payload.currentTime !== h.lastTime) {
        h.lastTime = payload.currentTime;
        h.lastProgressAt = now;
        h.alerted = false;
      }
      paneHealth.set(payload.webContentsId, h);

      if (!h.alerted && now - h.lastProgressAt > STALL_TIMEOUT_MS) {
        h.alerted = true;
        const program = panePrograms[slot];
        logToMain('[WATCHDOG] stalled ' + Math.round((now - h.lastProgressAt) / 1000) +
          's in pane ' + (slot + 1) + ' (' + program.stationName + '); re-streaming');
        attemptStream(pane, slot, program.stationName, program.dlhdId, program.programName);
      }
    });

    // Pane drag-swap cursor stream (09-27): main polls the OS cursor at
    // 10 Hz and streams points while a drag is armed (host mouse events
    // don't cross webview guests). Registered once; routed to the active
    // drag via dragCursorHandler.
    if (window.channelSurfer.onDragCursor) {
      window.channelSurfer.onDragCursor((payload) => {
        if (dragCursorHandler) dragCursorHandler(payload);
      });
    }

    // Remote is authoritative: every fresh generation replaces whatever
    // is on screen — including a local fallback loaded during an outage.
    window.channelSurfer.onScheduleReady((payload) => {
      if (payload && typeof payload.path === 'string' && payload.path) {
        schedulePath = payload.path;
        loadSchedule();
      }
    });

    // Remote-first fallback: main declared the remote unreachable after
    // bounded retries. Resort to the local file; the same-day freshness
    // gate inside loadSchedule still applies — a fallback, not a loophole.
    window.channelSurfer.onScheduleUnavailable(() => {
      if (scheduleData) return; // fresh data already on screen
      loadSchedule();
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
  statusScreen.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;display:flex;align-items:center;justify-content:center;font-size:1.25rem;z-index:1000;background:' + themeBg + ';color:' + bodyStyle.color + ';';
  document.body.appendChild(statusScreen);
  guideStatusShownAt = Date.now();
  updateGuideStatusScreen();

  // Defensive: if any pane div lacks data-pane (older HTML), assign by DOM
  // order so the slot mapping is always defined.
  document.querySelectorAll('#panes-container .view-pane').forEach((pane, i) => {
    if (pane.dataset.pane === undefined) pane.dataset.pane = String(i);
  });

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

// ---------- Schedule column-divider sync ----------
// The header spans the full overlay width; the rows live inside the
// scrollable list, narrower than the overlay by the vertical scrollbar.
// Equal percentages therefore land on different pixels - the divider
// drifts whenever the list's clientWidth changes (window resize, pane
// layout change, scrollbar appearance/disappearance). Fix: derive BOTH
// from one px value = stationColumnWidth% of the list's current
// clientWidth, re-applied on every such change.
function syncOverlayDividers(overlay) {
  if (!overlay || !overlay.isConnected) return;
  const listContainer = overlay.querySelector('.pane-schedule-list');
  const headerStation = overlay.querySelector('.pane-schedule-header-station');
  if (!listContainer || !headerStation) return;
  const listWidth = listContainer.clientWidth;
  if (listWidth <= 0) return;
  const px = (stationColumnWidth / 100) * listWidth;
  headerStation.style.width = px + 'px';
  headerStation.style.minWidth = px + 'px';
  overlay.querySelectorAll('.pane-schedule-station').forEach(station => {
    station.style.width = px + 'px';
    station.style.minWidth = px + 'px';
  });
}

function syncAllOverlayDividers() {
  document.querySelectorAll('.pane-schedule-overlay').forEach(syncOverlayDividers);
}

window.addEventListener('resize', () => {
  requestAnimationFrame(syncAllOverlayDividers);
});
