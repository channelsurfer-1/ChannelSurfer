// src/getSchedule.js

const fs = require('fs');
const path = require('path');
const { getMapping } = require('./mapChannels');

const EPG_PATH = path.join(__dirname, '..', 'data', 'epg_ripper_US2.xml');

function loadEpgXml() {
  return fs.readFileSync(EPG_PATH, 'utf8');
}

function parseProgrammes(xml) {
  const programmes = [];
  const programmeRegex = /<programme[^>]*channel="([^"]+)"[^>]*start="([^"]+)"[^>]*stop="([^"]+)"[^>]*>/g;
  const titleRegex = /<title[^>]*>(.*?)<\/title>/;
  const subTitleRegex = /<sub-title[^>]*>(.*?)<\/sub-title>/;
  const descRegex = /<desc[^>]*>(.*?)<\/desc>/;

  let match;
  while ((match = programmeRegex.exec(xml)) !== null) {
    const blockStart = match.index;
    const nextBlock = xml.indexOf('<programme', blockStart + 1);
    const blockEnd = nextBlock === -1 ? xml.length : nextBlock;
    const block = xml.slice(blockStart, blockEnd);

    const title = titleRegex.exec(block);
    const subTitle = subTitleRegex.exec(block);
    const desc = descRegex.exec(block);

    programmes.push({
      channel: match[1],
      start: match[2],
      stop: match[3],
      title: title ? title[1].trim() : '',
      episode: subTitle ? subTitle[1].trim() : '',
      description: desc ? desc[1].trim() : ''
    });
  }

  return programmes;
}

function getScheduleForChannel(dlhdId) {
  const mapping = getMapping();
  const channel = mapping[String(dlhdId)];

  if (!channel) {
    return null;
  }

  const xml = loadEpgXml();
  const programmes = parseProgrammes(xml);
  return programmes.filter(p => p.channel === channel.epg_id);
}

function getCurrentProgram(dlhdId, now = new Date()) {
  const programmes = getScheduleForChannel(dlhdId);
  if (!programmes) return null;

  const nowStr = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, ' +0000');

  return programmes.find(p => p.start <= nowStr && p.stop >= nowStr) || null;
}

function getAllSchedules() {
  const mapping = getMapping();
  const xml = loadEpgXml();
  const programmes = parseProgrammes(xml);

  const result = {};
  for (const [dlhdId, channel] of Object.entries(mapping)) {
    result[dlhdId] = {
      dlhd_name: channel.dlhd_name,
      epg_id: channel.epg_id,
      programmes: programmes.filter(p => p.channel === channel.epg_id)
    };
  }
  return result;
}

module.exports = {
  parseProgrammes,
  getScheduleForChannel,
  getCurrentProgram,
  getAllSchedules
};