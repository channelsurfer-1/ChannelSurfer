const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const sourceDir = '/Users/joel/Data/Computer/Apps/ChannelSurfer/images/logos/logos';
const outputDir = '/Users/joel/Data/Computer/Apps/ChannelSurfer/images/logos/new-logos';

if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

const TARGET_HEIGHT = 40; // 2x resolution for retina
const PADDING = 2; // minimal padding (display size)
const BACKGROUND_COLOR = { r: 245, g: 245, b: 245, alpha: 1 };
const CORNER_RADIUS = 4; // subtle rounded corners

async function processPNG(filePath, outputPath) {
  try {
    const image = sharp(filePath);
    const metadata = await image.metadata();
    
    const scaleFactor = TARGET_HEIGHT / metadata.height;
    const scaledWidth = Math.round(metadata.width * scaleFactor);
    const scaledPadding = PADDING * 2; // 2x for retina
    
    const newWidth = scaledWidth + (scaledPadding * 2);
    const newHeight = TARGET_HEIGHT + (scaledPadding * 2);
    
    const background = Buffer.from(
      '<svg width="' + newWidth + '" height="' + newHeight + '">' +
      '<rect x="0" y="0" width="' + newWidth + '" height="' + newHeight + '" ' +
      'rx="' + CORNER_RADIUS + '" ry="' + CORNER_RADIUS + '" ' +
      'fill="rgb(' + BACKGROUND_COLOR.r + ',' + BACKGROUND_COLOR.g + ',' + BACKGROUND_COLOR.b + ')"/>' +
      '</svg>'
    );
    
    await sharp(background)
      .composite([
        {
          input: await sharp(filePath)
            .resize({ height: TARGET_HEIGHT })
            .png()
            .toBuffer(),
          left: scaledPadding,
          top: scaledPadding
        }
      ])
      .png()
      .toFile(outputPath);
    
    console.log('Processed: ' + path.basename(filePath) + ' (' + newWidth + 'x' + newHeight + ')');
  } catch (err) {
    console.error('Error processing ' + filePath + ':', err.message);
  }
}

async function processSVG(filePath, outputPath) {
  try {
    const svgContent = fs.readFileSync(filePath, 'utf8');
    
    let width = 100;
    let height = 100;
    
    const viewBoxMatch = svgContent.match(/viewBox="(\d+)\s+(\d+)\s+(\d+)\s+(\d+)"/);
    
    if (viewBoxMatch) {
      width = parseInt(viewBoxMatch[3]);
      height = parseInt(viewBoxMatch[4]);
    }
    
    const scaleFactor = TARGET_HEIGHT / height;
    const scaledWidth = Math.round(width * scaleFactor);
    const scaledPadding = PADDING * 2;
    
    const newWidth = scaledWidth + (scaledPadding * 2);
    const newHeight = TARGET_HEIGHT + (scaledPadding * 2);
    
    const newSVG = '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<svg width="' + newWidth + '" height="' + newHeight + '" viewBox="0 0 ' + newWidth + ' ' + newHeight + '" xmlns="http://www.w3.org/2000/svg">\n' +
      '  <rect x="0" y="0" width="' + newWidth + '" height="' + newHeight + '" \n' +
      '        rx="' + CORNER_RADIUS + '" ry="' + CORNER_RADIUS + '" \n' +
      '        fill="#F5F5F5"/>\n' +
      '  <g transform="translate(' + scaledPadding + ', ' + scaledPadding + ') scale(' + scaleFactor + ')">\n' +
      svgContent.replace(/<\?xml[^?]*\?>/, '').replace(/<svg[^>]*>/, '').replace(/<\/svg>/, '') +
      '  </g>\n' +
      '</svg>';
    
    fs.writeFileSync(outputPath, newSVG);
    console.log('Processed: ' + path.basename(filePath) + ' (' + newWidth + 'x' + newHeight + ')');
  } catch (err) {
    console.error('Error processing ' + filePath + ':', err.message);
  }
}

async function main() {
  const files = fs.readdirSync(sourceDir);
  
  for (const file of files) {
    const filePath = path.join(sourceDir, file);
    const outputPath = path.join(outputDir, file);
    
    if (file.endsWith('.png')) {
      await processPNG(filePath, outputPath);
    } else if (file.endsWith('.svg')) {
      await processSVG(filePath, outputPath);
    }
  }
  
  console.log('Processing complete!');
  console.log('Images resized to ' + TARGET_HEIGHT + 'px height with minimal padding');
}

main();