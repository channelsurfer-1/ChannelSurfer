// src/mapChannels.js

const fs = require('fs');
const path = require('path');

const MAPPING_PATH = path.join(__dirname, '..', 'data', 'final_channel_mapping.json');

function loadMapping() {
  const raw = fs.readFileSync(MAPPING_PATH, 'utf8');
  return JSON.parse(raw);
}

function getMapping() {
  return loadMapping();
}

function getDlhdName(dlhdId) {
  const mapping = loadMapping();
  const entry = mapping[String(dlhdId)];
  return entry ? entry.dlhd_name : null;
}

function getEpgId(dlhdId) {
  const mapping = loadMapping();
  const entry = mapping[String(dlhdId)];
  return entry ? entry.epg_id : null;
}

function getChannelByDlhdId(dlhdId) {
  const mapping = loadMapping();
  return mapping[String(dlhdId)] || null;
}

function getChannelByEpgId(epgId) {
  const mapping = loadMapping();
  for (const [dlhdId, entry] of Object.entries(mapping)) {
    if (entry.epg_id === epgId) {
      return {
        dlhd_id: dlhdId,
        ...entry
      };
    }
  }
  return null;
}

module.exports = {
  loadMapping,
  getMapping,
  getDlhdName,
  getEpgId,
  getChannelByDlhdId,
  getChannelByEpgId
};