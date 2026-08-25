/* HYPERMEMES — backend for the glasses try-on generator.
   Serves the static site + POST /api/try-on-glasses which sends the user's
   photo together with assets/kacamata.png to the image editing API via Krater.
   No npm dependencies — plain Node http. Requires Node 18+ (global fetch).

   Run:  node server.js
   Env:  PORT (default 3000), KRATER_API_KEY (REQUIRED), KRATER_MODEL (optional)
*/
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/* Minimal .env loader (no dependencies). Reads .env in the project root and
   populates process.env. Lines: KEY=value. Skips comments and blanks. */
(function loadEnv(){
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
})();

const PORT = process.env.PORT || 3000;
const KRATER_API_KEY = process.env.KRATER_API_KEY;
if (!KRATER_API_KEY) {
  console.error('KRATER_API_KEY is required. Set it before running:');
  console.error('  $env:KRATER_API_KEY="..." ; node server.js   (PowerShell)');
  process.exit(1);
}
const KRATER_URL = 'https://api.krater.ai/v1/chat/completions';
const MODEL = process.env.KRATER_MODEL || 'google/gemini-3.1-flash-image';
const ROOT = __dirname;
const GLASSES_PATH = path.join(ROOT, 'assets', 'kacamata.png');
const MAX_BODY = 30 * 1024 * 1024; // 30 MB

/* In-memory result cache — same input image returns the same edit without
   spending another API call. Key = sha1 of the raw image bytes. */
const CACHE = new Map();
const CACHE_MAX = 200; // keep memory bounded

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

const PROMPT = [
  'The first image is a photo of the person whose face must be edited. The second image shows the exact pair of sunglasses to add.',
  'Add ONLY the sunglasses from the second image onto the face of the person in the first image.',
  'The person in the output must be the IDENTICAL same person from the first image: same face, same identity, same facial features, same hairstyle, same body, same clothes, same background.',
  'Do NOT generate, replace, or alter the person in any way. Do NOT change their identity, facial structure, skin, expression, or pose.',
  'Preserve everything from the first image exactly as it is, except for the sunglasses that you add.',
  'Size, angle, and position the sunglasses so they sit naturally on the person\'s face, consistent with the photo\'s lighting.',
  'Keep the sunglasses looking exactly like they do in the second image.',
  'Output only the edited photo.',
].join(' ');

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('Payload too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

/* Extract the generated image (as a data URL) from an OpenRouter-style chat response. */
function extractImage(data) {
  const msg = data && data.choices && data.choices[0] && data.choices[0].message;
  if (!msg) return null;
  if (Array.isArray(msg.images) && msg.images.length) {
    const u = msg.images[0].image_url && msg.images[0].image_url.url;
    if (u) return u;
  }
  if (Array.isArray(msg.content)) {
    for (const part of msg.content) {
      if (part && part.type === 'image_url' && part.image_url && part.image_url.url) return part.image_url.url;
    }
  }
  return null;
}

async function tryOnGlasses(imageDataUrl) {
  const glassesDataUrl = 'data:image/png;base64,' + fs.readFileSync(GLASSES_PATH).toString('base64');
  const resp = await fetch(KRATER_URL, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + KRATER_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: PROMPT },
          { type: 'image_url', image_url: { url: imageDataUrl } },
          { type: 'image_url', image_url: { url: glassesDataUrl } },
        ],
      }],
    }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const msg = (data && data.error && (data.error.message || data.error)) || ('Krater error ' + resp.status);
    throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }
  const img = extractImage(data);
  if (!img) throw new Error('Model returned no image.');
  return img;
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'POST' && req.url === '/api/try-on-glasses') {
      const raw = await readBody(req);
      let payload;
      try { payload = JSON.parse(raw.toString('utf8')); }
      catch { return sendJson(res, 400, { error: 'Invalid JSON body' }); }
      if (!payload || typeof payload.image !== 'string' || !payload.image.startsWith('data:image/')) {
        return sendJson(res, 400, { error: 'Body must be { image: "data:image/..." }' });
      }
      try {
        const key = crypto.createHash('sha1').update(payload.image).digest('hex');
        if (CACHE.has(key)) {
          console.log('[try-on] cache hit');
          return sendJson(res, 200, { image: CACHE.get(key) });
        }
        const out = await tryOnGlasses(payload.image);
        CACHE.set(key, out);
        if (CACHE.size > CACHE_MAX) CACHE.delete(CACHE.keys().next().value);
        sendJson(res, 200, { image: out });
      } catch (err) {
        console.error('[try-on]', err.message);
        sendJson(res, 502, { error: err.message });
      }
      return;
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      let urlPath = decodeURIComponent(req.url.split('?')[0]);
      if (urlPath === '/') urlPath = '/index.html';
      const filePath = path.normalize(path.join(ROOT, urlPath));
      if (!filePath.startsWith(ROOT)) { res.writeHead(403); res.end('Forbidden'); return; }
      fs.stat(filePath, (err, st) => {
        if (err || !st.isFile()) { res.writeHead(404); res.end('Not found'); return; }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream' });
        if (req.method === 'HEAD') res.end();
        else fs.createReadStream(filePath).pipe(res);
      });
      return;
    }

    res.writeHead(405); res.end('Method not allowed');
  } catch (err) {
    console.error('[server]', err);
    sendJson(res, 500, { error: 'Internal server error' });
  }
});

server.listen(PORT, () => {
  console.log('HYPERMEMES site + try-on API running at http://localhost:' + PORT);
  console.log('Model: ' + MODEL);
});
