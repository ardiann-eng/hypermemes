/* HYPERMEMES — Vercel serverless function.
   Replaces server.js for the deployed /api/try-on-glasses endpoint.
   Vercel can't run long-lived Node servers, so this is a handler function.

   Env:  KRATER_API_KEY (REQUIRED, set in Vercel dashboard), KRATER_MODEL (optional)
   Run locally:  vercel dev   (or keep using node server.js)
*/
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const KRATER_API_KEY = process.env.KRATER_API_KEY;
const KRATER_URL = 'https://api.krater.ai/v1/chat/completions';
const MODEL = process.env.KRATER_MODEL || 'google/gemini-3.1-flash-image';
const GLASSES_PATH = path.join(process.cwd(), 'assets', 'kacamata.png');
const MAX_BODY = 4 * 1024 * 1024; // 4 MB — Vercel request body cap

const CACHE = new Map();
const CACHE_MAX = 100;

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

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('Payload too large (max 4 MB)')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.setHeader('Content-Type', 'application/json');
  res.statusCode = status;
  res.end(body);
}

module.exports = async (req, res) => {
  if (!KRATER_API_KEY) {
    sendJson(res, 500, { error: 'KRATER_API_KEY not set. Add it in Vercel project settings -> Environment Variables.' });
    return;
  }
  if (req.method !== 'POST' || req.url.split('?')[0] !== '/api/try-on-glasses') {
    sendJson(res, 404, { error: 'Not found' });
    return;
  }

  let raw;
  try { raw = await readBody(req); }
  catch (err) { sendJson(res, 413, { error: err.message }); return; }

  let payload;
  try { payload = JSON.parse(raw.toString('utf8')); }
  catch { sendJson(res, 400, { error: 'Invalid JSON body' }); return; }

  if (!payload || typeof payload.image !== 'string' || !payload.image.startsWith('data:image/')) {
    sendJson(res, 400, { error: 'Body must be { image: "data:image/..." }' });
    return;
  }

  try {
    const key = crypto.createHash('sha1').update(payload.image).digest('hex');
    if (CACHE.has(key)) return sendJson(res, 200, { image: CACHE.get(key) });
    const out = await tryOnGlasses(payload.image);
    CACHE.set(key, out);
    if (CACHE.size > CACHE_MAX) CACHE.delete(CACHE.keys().next().value);
    sendJson(res, 200, { image: out });
  } catch (err) {
    console.error('[try-on]', err.message);
    sendJson(res, 502, { error: err.message });
  }
};
