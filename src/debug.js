// Debug mode flag for ChannelSurfer.
// Enabled via environment variable CHANNELSURFER_DEBUG=1 or CLI arg --debug:
//   CHANNELSURFER_DEBUG=1 npm start
//   npm start -- --debug
// When disabled, every debug logging branch in the app skips and the
// console output is identical to a clean run.

const enabled = process.env.CHANNELSURFER_DEBUG === '1' || process.argv.includes('--debug');

module.exports = { enabled };
