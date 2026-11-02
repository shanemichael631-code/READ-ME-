// Builds the hosted copy of the hub: hub/index.html is hub.html plus a web app manifest link.
// Run after editing hub.html:  node tools/build-hub.js
const fs = require('fs'); const path = require('path');
const root = path.join(__dirname, '..');
let html = fs.readFileSync(path.join(root, 'hub.html'), 'utf8');
const anchor = '<meta name="apple-mobile-web-app-title" content="Nova Hub">\n';
if (!html.includes(anchor)) throw new Error('hub.html changed: anchor line for the manifest link not found');
html = html.replace(anchor, anchor + '<link rel="manifest" href="/manifest.webmanifest">\n');
// The hosted copy serves the home-screen icon as a file instead of an inline data URI.
html = html.replace(/<link rel="apple-touch-icon" sizes="180x180" href="data:image\/png;base64,[^"]+">/, '<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png">');
if (!html.includes('href="/apple-touch-icon.png"')) throw new Error('apple-touch-icon data URI not found in hub.html');
fs.mkdirSync(path.join(root, 'hub'), { recursive: true });
fs.writeFileSync(path.join(root, 'hub', 'index.html'), html);
console.log('wrote hub/index.html', html.length, 'bytes');
