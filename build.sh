#!/bin/bash

# Remove quarantine attributes and force delete old builds
xattr -rc ChannelSurfer-darwin-x64 2>/dev/null
xattr -rc ChannelSurfer-darwin-universal 2>/dev/null
rm -f ChannelSurfer-darwin-x64/.DS_Store 2>/dev/null
rm -f ChannelSurfer-darwin-universal/.DS_Store 2>/dev/null
rm -rf ChannelSurfer-darwin-x64 2>/dev/null
rm -rf ChannelSurfer-darwin-universal 2>/dev/null

# Install dependencies (skip audit to avoid npm hang)
npm install --no-audit --no-fund

# Fetch fresh EPG data
node src/fetchEpg.js

# Generate schedule data
node src/generateScheduleJson.js

# Common ignore patterns
IGNORE_PATTERNS=(
  "--ignore=^/ChannelSurfer\\.dmg$"
  "--ignore=^/ChannelSurfer-intel\\.dmg$"
  "--ignore=^/ChannelSurfer-universal\\.dmg$"
  "--ignore=^/build\\.sh$"
  "--ignore=^/documentation$"
  "--ignore=^/node_modules$"
  "--ignore=^/runtime$"
  "--ignore=^/data/epg_ripper_US2\\.xml$"
  "--ignore=^/data/epg_ripper_US2\\.xml\\.gz$"
  "--ignore=^/data/schedule\\.json$"
  "--ignore=^/data/security\\.log$"
  "--ignore=^/data/blocklist\\.txt$"
  "--extra-resource=images"
)

# Build x64 (Intel) Electron app
echo "Building Intel x64 version..."
npx electron-packager . ChannelSurfer \
  --platform=darwin \
  --arch=x64 \
  --overwrite \
  "${IGNORE_PATTERNS[@]}"

# Build Universal Electron app
echo "Building Universal version..."
npx electron-packager . ChannelSurfer \
  --platform=darwin \
  --arch=universal \
  --overwrite \
  "${IGNORE_PATTERNS[@]}"

# Apply icons to both builds
for build in ChannelSurfer-darwin-x64 ChannelSurfer-darwin-universal; do
  echo "Applying icon to $build..."
  cp images/icon.icns "$build/ChannelSurfer.app/Contents/Resources/icon.icns"
  /usr/libexec/PlistBuddy -c "Set :CFBundleIconFile icon.icns" "$build/ChannelSurfer.app/Contents/Info.plist"
  touch "$build/ChannelSurfer.app"
done

# Create DMGs
echo "Creating Intel DMG..."
rm -f ChannelSurfer-intel.dmg
mkdir -p dmg-intel
cp -R ChannelSurfer-darwin-x64/ChannelSurfer.app dmg-intel/
ln -s /Applications dmg-intel/Applications
hdiutil create -volname "ChannelSurfer Intel" -srcfolder dmg-intel -ov -format UDZO ChannelSurfer-intel.dmg
rm -rf dmg-intel

echo "Creating Universal DMG..."
rm -f ChannelSurfer-universal.dmg
mkdir -p dmg-universal
cp -R ChannelSurfer-darwin-universal/ChannelSurfer.app dmg-universal/
ln -s /Applications dmg-universal/Applications
hdiutil create -volname "ChannelSurfer Universal" -srcfolder dmg-universal -ov -format UDZO ChannelSurfer-universal.dmg
rm -rf dmg-universal

echo "Build complete!"
echo "Created:"
echo "  - ChannelSurfer-intel.dmg (Intel only)"
echo "  - ChannelSurfer-universal.dmg (Intel + Apple Silicon)"