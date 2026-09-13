#!/bin/bash

cd "$(dirname "$0")/.."

# Create dist directory if it doesn't exist
mkdir -p dist

# Remove quarantine attributes and force delete old builds
xattr -rc dist/ChannelSurfer-darwin-x64 2>/dev/null
xattr -rc dist/ChannelSurfer-darwin-universal 2>/dev/null
rm -f dist/ChannelSurfer-darwin-x64/.DS_Store 2>/dev/null
rm -f dist/ChannelSurfer-darwin-universal/.DS_Store 2>/dev/null
rm -rf dist/ChannelSurfer-darwin-x64 2>/dev/null
rm -rf dist/ChannelSurfer-darwin-universal 2>/dev/null

# Install dependencies (skip audit to avoid npm hang)
npm install --no-audit --no-fund

# Fetch fresh EPG data
node src/fetchEpg.js

# Generate schedule data
node src/generateScheduleJson.js

# Stage images/ for packaging, excluding local-only content
echo "Staging images..."
node scripts/stage-images.js images .staging-images/images

# Common ignore patterns
IGNORE_PATTERNS=(
  "--ignore=^/ChannelSurfer\\.dmg$"
  "--ignore=^/ChannelSurfer-intel\\.dmg$"
  "--ignore=^/ChannelSurfer-universal\\.dmg$"
  "--ignore=^/scripts$"
  "--ignore=^/documentation$"
  "--ignore=^/node_modules$"
  "--ignore=^/runtime$"
  "--ignore=^/dist$"
  "--ignore=^/.staging-images$"
  "--ignore=^/data/epg_ripper_US2\\.xml$"
  "--ignore=^/data/epg_ripper_US2\\.xml\\.gz$"
  "--ignore=^/data/schedule\\.json$"
  "--ignore=^/data/security\\.log$"
  "--ignore=^/data/blocklist\\.txt$"
  "--extra-resource=.staging-images/images"
)

# Build x64 (Intel) Electron app
echo "Building Intel x64 version..."
npx electron-packager . ChannelSurfer \
  --platform=darwin \
  --arch=x64 \
  --out=dist \
  --overwrite \
  "${IGNORE_PATTERNS[@]}"

# Build Universal Electron app
echo "Building Universal version..."
npx electron-packager . ChannelSurfer \
  --platform=darwin \
  --arch=universal \
  --out=dist \
  --overwrite \
  "${IGNORE_PATTERNS[@]}"

# Apply icons to both builds
for build in dist/ChannelSurfer-darwin-x64 dist/ChannelSurfer-darwin-universal; do
  echo "Applying icon to $build..."
  cp .staging-images/images/icon.icns "$build/ChannelSurfer.app/Contents/Resources/icon.icns"
  /usr/libexec/PlistBuddy -c "Set :CFBundleIconFile icon.icns" "$build/ChannelSurfer.app/Contents/Info.plist"
  touch "$build/ChannelSurfer.app"
done

# Create DMGs in dist directory
echo "Creating Intel DMG..."
rm -f dist/ChannelSurfer-intel.dmg
mkdir -p dist/dmg-intel
cp -R dist/ChannelSurfer-darwin-x64/ChannelSurfer.app dist/dmg-intel/
ln -s /Applications dist/dmg-intel/Applications
hdiutil create -volname "ChannelSurfer Intel" -srcfolder dist/dmg-intel -ov -format UDZO dist/ChannelSurfer-intel.dmg
rm -rf dist/dmg-intel

echo "Creating Universal DMG..."
rm -f dist/ChannelSurfer-universal.dmg
mkdir -p dist/dmg-universal
cp -R dist/ChannelSurfer-darwin-universal/ChannelSurfer.app dist/dmg-universal/
ln -s /Applications dist/dmg-universal/Applications
hdiutil create -volname "ChannelSurfer Universal" -srcfolder dist/dmg-universal -ov -format UDZO dist/ChannelSurfer-universal.dmg
rm -rf dist/dmg-universal

# Clean up staging
rm -rf .staging-images

echo "Build complete!"
echo "Created:"
echo "  - dist/ChannelSurfer-intel.dmg (Intel only)"
echo "  - dist/ChannelSurfer-universal.dmg (Intel + Apple Silicon)"
