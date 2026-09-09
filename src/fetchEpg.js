const https = require('https');
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

const EPG_URL = 'https://epgshare01.online/epgshare01/epg_ripper_US2.xml.gz';

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
    xml: path.join(dataDir, 'epg_ripper_US2.xml')
  };
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, (response) => {
      if (response.statusCode !== 200) {
        reject(new Error(`HTTP ${response.statusCode}`));
        return;
      }
      response.pipe(file);
      file.on('finish', () => {
        file.close();
        resolve(dest);
      });
    }).on('error', (err) => {
      fs.unlink(dest, () => {});
      reject(err);
    });
  });
}

function decompressGz(gzPath, outPath) {
  return new Promise((resolve, reject) => {
    const readStream = fs.createReadStream(gzPath);
    const writeStream = fs.createWriteStream(outPath);
    const gunzip = zlib.createGunzip();

    readStream
      .pipe(gunzip)
      .pipe(writeStream)
      .on('finish', () => {
        writeStream.close();
        resolve(outPath);
      })
      .on('error', reject);
  });
}

async function fetchEpg() {
  const paths = getPaths();
  console.log('Downloading EPG...');
  await downloadFile(EPG_URL, paths.gz);

  console.log('Decompressing EPG...');
  const xmlPath = await decompressGz(paths.gz, paths.xml);

  console.log('EPG ready at', xmlPath);
  return xmlPath;
}

module.exports = { fetchEpg, getPaths };

if (require.main === module) {
  fetchEpg().catch(err => {
    console.error('EPG fetch failed:', err);
    process.exit(1);
  });
}