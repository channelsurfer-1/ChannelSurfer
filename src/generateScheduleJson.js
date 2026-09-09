const fs = require('fs');
const path = require('path');
const { getMapping } = require('./mapChannels');
const { parseProgrammes } = require('./getSchedule');

const WINDOW_MS = 2.5 * 60 * 60 * 1000; // 2 hours 30 minutes

function getDataDir() {
  try {
    const { app } = require('electron');
    if (app && app.isPackaged) {
      return app.getPath('userData');
    }
  } catch (_) {
    // Not running inside Electron, fall back to local data folder
  }
  return path.join(__dirname, '..', 'data');
}

function getPaths() {
  const dataDir = getDataDir();
  return {
    epg: path.join(dataDir, 'epg_ripper_US2.xml'),
    schedule: path.join(dataDir, 'schedule.json')
  };
}

function toUtcDate(epgTime) {
  const timestamp = epgTime.split(' ')[0];

  const year = timestamp.slice(0, 4);
  const month = timestamp.slice(4, 6);
  const day = timestamp.slice(6, 8);
  const hour = timestamp.slice(8, 10);
  const minute = timestamp.slice(10, 12);
  const second = timestamp.slice(12, 14);

  return new Date(Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second)
  ));
}

function formatTime(date) {
  return date.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
    timeZone: 'UTC'
  });
}

function getWindowStart(now) {
  const start = new Date(now);
  const minutes = start.getMinutes();

  if (minutes < 30) {
    start.setMinutes(0, 0, 0);
  } else {
    start.setMinutes(30, 0, 0);
  }

  return start;
}

function buildSlots(programmes, windowStart, windowEnd) {
  const slots = [];
  const sorted = programmes
    .filter(p => p.title)
    .sort((a, b) => toUtcDate(a.start) - toUtcDate(b.start));

  for (const prog of sorted) {
    const start = toUtcDate(prog.start);
    const stop = toUtcDate(prog.stop);

    // Does this programme overlap the window?
    if (stop <= windowStart) continue;
    if (start >= windowEnd) continue;

    slots.push({
      program: prog.title,
      episode: prog.episode || '',
      description: prog.description || '',
      start: formatTime(start),
      stop: formatTime(stop),
      startRaw: prog.start,
      stopRaw: prog.stop,
      startMs: start.getTime(),
      stopMs: stop.getTime()
    });
  }

  return slots;
}

function generateScheduleJson() {
  const mapping = getMapping();
  const paths = getPaths();
  const xml = fs.readFileSync(paths.epg, 'utf8');
  const programmes = parseProgrammes(xml);

  const now = new Date();
  const windowStart = getWindowStart(now);
  const windowEnd = new Date(windowStart.getTime() + WINDOW_MS);

  const stations = {};

  for (const [dlhdId, channel] of Object.entries(mapping)) {
    const channelProgrammes = programmes.filter(p => p.channel === channel.epg_id);
    const slots = buildSlots(channelProgrammes, windowStart, windowEnd);

    stations[channel.dlhd_name] = {
      dlhdId,
      slots
    };
  }

  const result = {
    generatedAt: now.toISOString(),
    windowStart: windowStart.toISOString(),
    windowEnd: windowEnd.toISOString(),
    stations
  };

  fs.writeFileSync(paths.schedule, JSON.stringify(result, null, 2));
  console.log(`Schedule written to ${paths.schedule}`);

  return paths.schedule;
}

module.exports = { generateScheduleJson, toUtcDate };

if (require.main === module) {
  generateScheduleJson();
}