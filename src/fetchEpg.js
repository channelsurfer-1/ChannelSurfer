const https = require('https');
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

const EPG_URL = 'https://epgshare01.online/epgshare01/epg_ripper_US2.xml.gz';
const EPG_FETCH_TIMEOUT_MS = 15000;

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
    gz: path.join(dataDir, 'epg_ripper_US2.xml.gz'),
    xml: path.join(dataDir, 'epg_ripper_US2.xml'),
    gzPart: path.join(dataDir, 'epg_ripper_US2.xml.gz.part'),
    xmlPart: path.join(dataDir, 'epg_ripper_US2.xml.part')
  };
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), EPG_FETCH_TIMEOUT_MS);
    const file = fs.createWriteStream(dest);
    let settled = false;

    const fail = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      file.destroy();
      fs.unlink(dest, () => {});
      reject(err);
    };

    file.on('error', fail);

    const req = https.get(url, { signal: controller.signal }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        fail(new Error(`HTTP ${response.statusCode}`));
        return;
      }
      response.on('error', fail);
      response.pipe(file);
      file.on('finish', () => {
        file.close(() => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(dest);
        });
      });
    });

    req.on('error', (err) => {
      fail(controller.signal.aborted
        ? new Error(`EPG download timed out after ${EPG_FETCH_TIMEOUT_MS / 1000}s`)
        : err);
    });
  });
}

function decompressGz(gzPath, outPath) {
  return new Promise((resolve, reject) => {
    const readStream = fs.createReadStream(gzPath);
    const writeStream = fs.createWriteStream(outPath);
    const gunzip = zlib.createGunzip();
    let settled = false;

    const fail = (err) => {
      if (settled) return;
      settled = true;
      readStream.destroy();
      gunzip.destroy();
      writeStream.destroy();
      fs.unlink(outPath, () => {});
      reject(err);
    };

    readStream.on('error', fail);
    gunzip.on('error', fail);
    writeStream.on('error', fail);

    readStream
      .pipe(gunzip)
      .pipe(writeStream);

    writeStream.on('finish', () => {
      writeStream.close(() => {
        if (settled) return;
        settled = true;
        resolve(outPath);
      });
    });
  });
}

async function fetchEpg() {
  const paths = getPaths();
  console.log('Downloading EPG...');
  await downloadFile(EPG_URL, paths.gzPart);
  fs.renameSync(paths.gzPart, paths.gz);

  console.log('Decompressing EPG...');
  await decompressGz(paths.gz, paths.xmlPart);
  fs.renameSync(paths.xmlPart, paths.xml);

  console.log('EPG ready at', paths.xml);
  return paths.xml;
}

module.exports = { fetchEpg, getPaths };

if (require.main === module) {
  fetchEpg().catch(err => {
    console.error('EPG fetch failed:', err);
    process.exit(1);
  });
}
