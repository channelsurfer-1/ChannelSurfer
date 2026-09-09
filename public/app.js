let scheduleData = null;
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

const BASE_STREAM_URL = 'https://dlhd.st/stream/stream-';

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

  const maxPanes = getMaxPanes();
  const allPanes = panesContainer.querySelectorAll('.view-pane');
  allPanes.forEach((pane, index) => {
    pane.style.display = index < maxPanes ? 'block' : 'none';
  });

  updateModeButtonIcons();
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
  webview.useragent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';
  webview.setAttribute('allowfullscreen', 'true');
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

function showTooltip(e) {
  const text = e.currentTarget.dataset.tooltip;
  if (!text) return;

  tooltipTimer = setTimeout(() => {
    const tooltip = document.getElementById('tooltip');
    tooltip.innerHTML = text;
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
  const maxPanes = getMaxPanes();
  const viewState = viewStates[currentViewMode];

  viewState.forEach((program, index) => {
    if (program && program.dlhdId === dlhdId) {
      const pane = allPanes[index];
      if (pane) {
        const existingLabel = pane.querySelector('.pane-label');
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
        pane.appendChild(label);
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

  allPanes.forEach((pane, index) => {
    if (index < maxPanes) {
      pane.innerHTML = '';
      pane.onclick = null;
    }
  });

  if (currentViewMode === 'single' && !viewState[0] && scheduleData) {
    const singlePane = allPanes[0];
    if (singlePane) {
      showScheduleOverlay(singlePane, 0, null);
    }
    updateModeButtonIcons();
    return;
  }

  viewState.forEach((program, index) => {
    if (index >= maxPanes) return;

    const pane = allPanes[index];
    if (!pane) return;

    if (program) {
      const webview = createWebview(program.stationName, program.url);
      pane.appendChild(webview);

      if (program.programName) {
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
        labelText.textContent = program.programName;

        label.appendChild(logoImg);
        label.appendChild(labelText);
        pane.appendChild(label);
      }

      addPaneCloseButton(pane, index);
    } else {
      const placeholder = document.createElement('div');
      placeholder.className = 'pane-placeholder';
      placeholder.textContent = 'Click to select a program';
      pane.appendChild(placeholder);

      pane.addEventListener('click', () => {
        showScheduleOverlay(pane, index, null);
      });
    }
  });

  scheduleOverlayStates[currentViewMode].forEach((isOpen, index) => {
    if (isOpen && index < maxPanes) {
      const pane = allPanes[index];
      if (pane && !pane.querySelector('.pane-schedule-overlay')) {
        showScheduleOverlay(pane, index, viewState[index] || null);
      }
    }
  });

  updateModeButtonIcons();
}

function showScheduleOverlay(pane, paneIndex, existingProgram) {
  const allPanes = document.querySelectorAll('.view-pane');
  
  allPanes.forEach((otherPane, index) => {
    if (otherPane !== pane) {
      const otherOverlay = otherPane.querySelector('.pane-schedule-overlay');
      if (otherOverlay) {
        // Save the scroll position of the overlay being removed
        const otherListContainer = otherOverlay.querySelector('.pane-schedule-list');
        if (otherListContainer) {
          scheduleScrollPositions[currentViewMode][index] = otherListContainer.scrollTop;
        }
        
        otherOverlay.remove();
        scheduleOverlayStates[currentViewMode][index] = false;
        
        const otherProgram = viewStates[currentViewMode][index];
        if (otherProgram) {
          const existingWebview = otherPane.querySelector('webview');
          if (existingWebview) {
            existingWebview.style.display = '';
          }
          
          if (!otherPane.querySelector('.pane-label') && otherProgram.programName) {
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
            otherPane.appendChild(label);
          }
        } else {
          if (!otherPane.querySelector('.pane-placeholder')) {
            const placeholder = document.createElement('div');
            placeholder.className = 'pane-placeholder';
            placeholder.textContent = 'Click to select a program';
            otherPane.appendChild(placeholder);

            otherPane.addEventListener('click', () => {
              showScheduleOverlay(otherPane, index, null);
            });
          }
        }
      }
    }
  });

  scheduleOverlayStates[currentViewMode][paneIndex] = true;

  const existingOverlay = pane.querySelector('.pane-schedule-overlay');
  if (existingOverlay) {
    const existingListContainer = existingOverlay.querySelector('.pane-schedule-list');
    if (existingListContainer) {
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

  pane.appendChild(overlay);

  populateScheduleList(listContainer, pane, paneIndex);
  
  // Restore scroll position after rendering
  listContainer.scrollTop = scheduleScrollPositions[currentViewMode][paneIndex] || 0;
  
  updateModeButtonIcons();
}

function populateScheduleList(listContainer, pane, paneIndex) {
  if (!scheduleData || !scheduleData.stations) return;

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
    stationText.title = displayName;
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
      programSpan.title = programTitle;
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

    const fullTooltip = programTitle
      ? `<strong>${programTitle}</strong><br>${programDescription}`
      : programDescription;

    row.dataset.tooltip = fullTooltip;
    row.addEventListener('mouseenter', showTooltip);
    row.addEventListener('mousemove', moveTooltip);
    row.addEventListener('mouseleave', hideTooltip);

    row.addEventListener('click', (e) => {
      if (isResizingColumn) return;
      
      e.stopPropagation();

      hideTooltip();

      // Save scroll position before closing
      const listContainer = pane.querySelector('.pane-schedule-list');
      if (listContainer) {
        scheduleScrollPositions[currentViewMode][paneIndex] = listContainer.scrollTop;
      }

      viewStates[currentViewMode][paneIndex] = {
        stationName: displayName,
        dlhdId: stationObj.dlhdId,
        programName: programTitle,
        url: `${BASE_STREAM_URL}${stationObj.dlhdId}.php`
      };

      scheduleOverlayStates[currentViewMode][paneIndex] = false;

      scheduleProgramTimer(stationObj.dlhdId);

      updateModeButtonIcons();

      const overlay = pane.querySelector('.pane-schedule-overlay');
      if (overlay) {
        overlay.remove();
      }

      pane.innerHTML = '';

      const webview = createWebview(displayName, `${BASE_STREAM_URL}${stationObj.dlhdId}.php`);
      pane.appendChild(webview);

      if (programTitle) {
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
        pane.appendChild(label);
      }

      addPaneCloseButton(pane, paneIndex);
    });

    listContainer.appendChild(row);
  });
}

function addPaneCloseButton(pane, paneIndex) {
  const closeBtn = document.createElement('button');
  closeBtn.className = 'pane-close-btn';
  closeBtn.innerHTML = '&times;';
  closeBtn.title = 'Close stream';

  closeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    
    const webview = pane.querySelector('webview');
    if (webview) {
      webview.remove();
    }
    
    viewStates[currentViewMode][paneIndex] = null;
    scheduleOverlayStates[currentViewMode][paneIndex] = false;
    updateModeButtonIcons();
    
    pane.innerHTML = '';
    
    showScheduleOverlay(pane, paneIndex, null);
  });

  pane.appendChild(closeBtn);
}

document.addEventListener('DOMContentLoaded', () => {
  let schedulePath = '../data/schedule.json';

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

  function decodeEntities(str) {
    if (!str) return '';
    const textarea = document.createElement('textarea');
    textarea.innerHTML = str;
    return textarea.value;
  }

  async function loadSchedule() {
    try {
      const cacheBuster = `?_=${Date.now()}`;
      const response = await fetch(`${schedulePath}${cacheBuster}`);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const data = await response.json();
      scheduleData = data;
      
      // Reset scroll positions when schedule data reloads
      scheduleScrollPositions = {
        single: [0],
        split: [0, 0],
        quad: [0, 0, 0, 0]
      };
      
      Object.values(viewStates).forEach(state => {
        state.forEach(program => {
          if (program) {
            scheduleProgramTimer(program.dlhdId);
          }
        });
      });

      updateModeButtonIcons();
      renderView();
    } catch (err) {
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

    const listContainer = openOverlay.querySelector('.pane-schedule-list');
    const pane = openOverlay.parentElement;
    const paneIndex = Array.from(pane.parentElement.children).indexOf(pane);

    if (listContainer && pane && paneIndex !== -1) {
      const scrollPos = listContainer.scrollTop;
      listContainer.innerHTML = '';
      populateScheduleList(listContainer, pane, paneIndex);
      listContainer.scrollTop = scrollPos;
    }
  }

  try {
    const { ipcRenderer } = require('electron');
    ipcRenderer.invoke('get-schedule-path').then((p) => {
      if (p) schedulePath = p;
      loadSchedule();
    });
  } catch (_) {
    loadSchedule();
  }

  scheduleNextRefresh();
  scheduleOverlayRefresh();
});