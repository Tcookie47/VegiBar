'use strict';

// ---------- Config ----------
const DEFAULT_MODEL = 'openrouter/free';
// Tried in order after the user's chosen model if it errors (rate limit, model retired, etc.)
const FALLBACK_MODELS = [
  'openrouter/free',
  'meta-llama/llama-3.3-70b-instruct:free',
  'deepseek/deepseek-chat-v3-0324:free',
  'google/gemma-3-27b-it:free',
  'mistralai/mistral-small-3.2-24b-instruct:free',
];
// Must accept images, used for "Photo of ingredients"
const VISION_FALLBACK_MODELS = [
  'openrouter/free',
  'google/gemma-3-27b-it:free',
  'mistralai/mistral-small-3.2-24b-instruct:free',
  'qwen/qwen2.5-vl-72b-instruct:free',
  'meta-llama/llama-4-maverick:free',
];
const OFF_FIELDS = [
  'code', 'product_name', 'product_name_en', 'brands', 'image_front_small_url',
  'ingredients_text', 'ingredients_text_en', 'ingredients_analysis_tags',
  'labels_tags', 'allergens_tags', 'traces_tags',
  'nutriments', 'nutriscore_grade', 'nova_group', 'serving_size',
].join(',');
const HISTORY_MAX = 25;
const CACHE_MAX = 500;
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const VERDICT_TEXT = {
  vegan: 'Vegan',
  vegetarian: 'Vegetarian',
  non_vegetarian: 'Non‑veg',
  unknown: 'Not sure',
};

// ---------- Storage ----------
const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem('vegibar.' + key);
      return v === null ? fallback : JSON.parse(v);
    } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem('vegibar.' + key, JSON.stringify(value)); } catch {}
  },
};
// ---------- Result cache ----------
// Finished results keyed by barcode, so a repeat scan needs no network or LLM call.
// A verdict depends on the egg setting, so entries made under another setting miss.
function cacheGet(code) {
  const hit = store.get('cache', {})[code];
  if (!hit || hit.eggMode !== settings().eggMode || Date.now() - hit.at > CACHE_TTL_MS) return null;
  return hit;
}

function cachePut(entry) {
  const cache = store.get('cache', {});
  cache[entry.meta.code] = entry;
  let codes = Object.keys(cache).sort((a, b) => cache[b].at - cache[a].at);
  for (const c of codes.slice(CACHE_MAX)) delete cache[c];
  codes = codes.slice(0, CACHE_MAX);
  // If storage is full, drop the oldest half and try again
  try {
    localStorage.setItem('vegibar.cache', JSON.stringify(cache));
  } catch {
    for (const c of codes.slice(Math.ceil(codes.length / 2))) delete cache[c];
    store.set('cache', cache);
  }
}

const settings = () => ({
  apiKey: store.get('apiKey', ''),
  model: store.get('model', '') || DEFAULT_MODEL,
  eggMode: store.get('eggMode', 'nonveg'),
});

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const els = {
  reader: $('reader'),
  video: $('video'),
  aim: document.querySelector('.aim'),
  torchBtn: $('torchBtn'),
  placeholder: $('readerPlaceholder'),
  scanBtn: $('scanBtn'),
  manualBtn: $('manualBtn'),
  manualForm: $('manualForm'),
  manualCode: $('manualCode'),
  photoBtn: $('photoBtn'),
  photoInput: $('photoInput'),
  status: $('status'),
  result: $('result'),
  historySection: $('historySection'),
  historyList: $('historyList'),
  settingsBtn: $('settingsBtn'),
  settings: $('settings'),
  apiKey: $('apiKey'),
  model: $('model'),
  clearHistory: $('clearHistory'),
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

function setStatus(text, { spin = false, error = false } = {}) {
  if (!text) { els.status.hidden = true; return; }
  els.status.hidden = false;
  els.status.className = 'status' + (error ? ' error' : '');
  els.status.innerHTML = (spin ? '<div class="spinner"></div>' : '') + `<span>${esc(text)}</span>`;
}

// ---------- Scanner ----------
const BARCODE_FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf'];
const SCAN_INTERVAL_MS = 120;
let stream = null;
let scanning = false;
let detector = null;
let scanTimer = null;
const frameCanvas = document.createElement('canvas');

// Prefer the phone's built-in detector (Android Chrome); otherwise use the
// ZXing-C++ WebAssembly ponyfill (iPhone Safari, Firefox, desktop).
async function getDetector() {
  if (detector) return detector;
  if ('BarcodeDetector' in window) {
    try {
      const supported = await window.BarcodeDetector.getSupportedFormats();
      if (supported.includes('ean_13')) {
        detector = new window.BarcodeDetector({ formats: BARCODE_FORMATS.filter((f) => supported.includes(f)) });
        return detector;
      }
    } catch {}
  }
  if (window.BarcodeDetectionAPI?.BarcodeDetector) {
    detector = new window.BarcodeDetectionAPI.BarcodeDetector({ formats: BARCODE_FORMATS });
    return detector;
  }
  throw new Error('Barcode decoder failed to load. Check your connection, or type the barcode.');
}

async function startScan() {
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    setStatus('Camera needs HTTPS. Open this app over https:// (e.g. GitHub Pages).', { error: true });
    return;
  }
  els.result.hidden = true;
  setStatus('Starting camera…', { spin: true });
  try {
    const [det, s] = await Promise.all([
      getDetector(),
      navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
      }),
    ]);
    stream = s;
    const track = stream.getVideoTracks()[0];
    const caps = track.getCapabilities?.() || {};
    if (caps.focusMode?.includes('continuous')) {
      track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
    }
    els.torchBtn.hidden = !caps.torch;
    els.torchBtn.classList.remove('on');

    els.video.srcObject = stream;
    els.placeholder.hidden = true;
    els.reader.hidden = false;
    await els.video.play();
    scanning = true;
    els.scanBtn.textContent = 'Stop scanning';
    setStatus('Hold the barcode inside the box, about a hand-width away.');
    scanLoop(det);
  } catch (err) {
    await stopScan();
    const msg = err?.name === 'NotAllowedError'
      ? 'Camera permission was denied. Allow camera access for this site in your browser settings.'
      : 'Could not start scanning: ' + (err?.message || err) + '. You can type the barcode instead.';
    setStatus(msg, { error: true });
  }
}

// Decode only the region inside the on-screen aiming box (mapped through
// object-fit: cover), which is faster and avoids picking up stray codes.
function grabFrame() {
  const v = els.video;
  const vw = v.videoWidth, vh = v.videoHeight;
  if (!vw || !vh) return null;
  const box = v.getBoundingClientRect();
  const aim = els.aim.getBoundingClientRect();
  const scale = Math.max(box.width / vw, box.height / vh);
  const offX = (box.width - vw * scale) / 2;
  const offY = (box.height - vh * scale) / 2;
  const pad = 0.1; // decode a little beyond the box for tolerance
  let x = (aim.left - box.left - offX) / scale;
  let y = (aim.top - box.top - offY) / scale;
  let w = aim.width / scale;
  let h = aim.height / scale;
  x = Math.max(0, x - w * pad); y = Math.max(0, y - h * pad);
  w = Math.min(vw - x, w * (1 + 2 * pad)); h = Math.min(vh - y, h * (1 + 2 * pad));
  const out = Math.min(1, 1280 / w);
  frameCanvas.width = Math.round(w * out);
  frameCanvas.height = Math.round(h * out);
  frameCanvas.getContext('2d', { willReadFrequently: true })
    .drawImage(v, x, y, w, h, 0, 0, frameCanvas.width, frameCanvas.height);
  return frameCanvas;
}

async function scanLoop(det) {
  if (!scanning) return;
  try {
    const frame = grabFrame();
    if (frame) {
      const codes = await det.detect(frame);
      const hit = codes.find((c) => /^\d{6,14}$/.test(c.rawValue)) || codes[0];
      if (hit && scanning) { onScan(hit.rawValue); return; }
    }
  } catch (e) {
    console.warn('detect failed', e);
  }
  scanTimer = setTimeout(() => scanLoop(det), SCAN_INTERVAL_MS);
}

async function stopScan() {
  scanning = false;
  clearTimeout(scanTimer);
  els.scanBtn.textContent = 'Scan barcode';
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  els.video.srcObject = null;
  els.reader.hidden = true;
  els.placeholder.hidden = false;
}

async function toggleTorch() {
  const track = stream?.getVideoTracks()[0];
  if (!track) return;
  const on = !els.torchBtn.classList.contains('on');
  try {
    await track.applyConstraints({ advanced: [{ torch: on }] });
    els.torchBtn.classList.toggle('on', on);
  } catch {}
}

async function onScan(code) {
  if (!scanning) return;
  if (navigator.vibrate) navigator.vibrate(80);
  await stopScan();
  analyzeBarcode(code.trim());
}

// ---------- Open Food Facts ----------
async function fetchProduct(code) {
  const url = `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(code)}.json?fields=${OFF_FIELDS}`;
  const res = await fetch(url);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Open Food Facts returned ${res.status}`);
  const data = await res.json();
  if (data.status !== 1 || !data.product) return null;
  return data.product;
}

function productIngredients(p) {
  return (p.ingredients_text_en || p.ingredients_text || '').trim();
}

function prettyTag(t) {
  return t.replace(/^[a-z]{2}:/, '').replace(/-/g, ' ');
}

// Signals OFF already computed, passed to the LLM as hints and shown to the user
function productHints(p) {
  const interesting = /vegan|vegetarian|non-vegetarian|palm-oil-free|halal|kosher|green-dot|brown-dot/;
  return [
    ...(p.ingredients_analysis_tags || []).filter((t) => /vegan|vegetarian/.test(t)),
    ...(p.labels_tags || []).filter((t) => interesting.test(t)),
    ...(p.allergens_tags || []).map((t) => 'allergen: ' + prettyTag(t)),
  ];
}

const NUTRIENTS = [
  ['energy-kcal', 'Energy', 'kcal'],
  ['fat', 'Fat', 'g'],
  ['saturated-fat', '  of which saturated', 'g'],
  ['carbohydrates', 'Carbohydrates', 'g'],
  ['sugars', '  of which sugars', 'g'],
  ['fiber', 'Fibre', 'g'],
  ['proteins', 'Protein', 'g'],
  ['salt', 'Salt', 'g'],
];

function productNutrition(p) {
  const n = p.nutriments || {};
  const rows = NUTRIENTS
    .filter(([key]) => typeof n[`${key}_100g`] === 'number')
    .map(([key, label, unit]) => ({ label, value: n[`${key}_100g`], unit, sub: label.startsWith('  ') }));
  const grade = /^[a-e]$/.test(p.nutriscore_grade || '') ? p.nutriscore_grade : '';
  const nova = [1, 2, 3, 4].includes(Number(p.nova_group)) ? Number(p.nova_group) : 0;
  if (!rows.length && !grade && !nova) return null;
  return { rows, grade, nova, serving: p.serving_size || '' };
}

// ---------- OpenRouter ----------
function systemPrompt(eggMode) {
  const eggRule = eggMode === 'nonveg'
    ? 'EGGS make a product NON-VEGETARIAN (Indian convention).'
    : 'EGGS are VEGETARIAN (Western lacto-ovo convention) but not vegan.';
  return `You are a meticulous food-ingredient analyst. Decide whether a packaged food is vegan, vegetarian or non-vegetarian from its ingredient list.

Definitions:
- vegan: no animal-derived ingredients at all (no meat, fish, seafood, dairy, eggs, honey, gelatin, carmine/cochineal/E120, shellac/E904, beeswax, lanolin-derived vitamin D3, isinglass, etc.).
- vegetarian: no flesh of any animal and no slaughter by-products (gelatin, animal rennet, lard, tallow, fish oil, bone char, carmine/E120, isinglass). Dairy and honey are allowed.
- non_vegetarian: contains meat, poultry, fish, seafood, or slaughter by-products such as gelatin, animal rennet, lard, fish sauce, anchovy, carmine/E120.
- ${eggRule}
- unknown: only if the ingredient list is missing or unreadable.

Ambiguous ingredients (e.g. E471/mono- and diglycerides, E422 glycerol, E631/E627 nucleotides, "natural flavours", enzymes, cheese/whey without rennet source, L-cysteine/E920, vitamin D3, E322 lecithin without source, stearic acid) can come from animals OR plants. Flag them as "ambiguous", explain both possible sources, pick the most likely verdict, and lower confidence. If a vegetarian/vegan label or Indian green-dot mark is present in the hints, use it to resolve ambiguity.

Respond with ONLY a JSON object, no markdown, in this exact shape:
{
  "verdict": "vegan" | "vegetarian" | "non_vegetarian" | "unknown",
  "confidence": "high" | "medium" | "low",
  "summary": "1-3 sentence justification naming the decisive ingredients",
  "flagged": [
    { "ingredient": "name as written", "category": "meat" | "fish" | "egg" | "dairy" | "honey" | "insect" | "animal" | "ambiguous", "reason": "short explanation" }
  ],
  "ingredients_read": "the full ingredient list as you read it (important when reading from an image)",
  "product_name": "product name if visible, else empty string"
}
"flagged" lists every animal-derived or ambiguous ingredient; leave it empty if the product is clearly vegan.`;
}

// Free models are often briefly rate-limited (429) or overloaded, so each
// round tries every candidate model, then waits and goes round again.
const RETRY_DELAYS_MS = [0, 3000, 8000];
const REQUEST_TIMEOUT_MS = 45000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shortModel = (m) => m.split('/').pop();

async function callOpenRouter(messages, { vision = false } = {}) {
  const { apiKey, model } = settings();
  if (!apiKey) throw new Error('NO_KEY');
  let candidates = [...new Set([model, ...(vision ? VISION_FALLBACK_MODELS : FALLBACK_MODELS)])];
  const errors = new Map(); // latest error per model
  for (let round = 0; round < RETRY_DELAYS_MS.length && candidates.length; round++) {
    if (RETRY_DELAYS_MS[round]) {
      for (let left = RETRY_DELAYS_MS[round] / 1000; left > 0; left--) {
        setStatus(`Free models are busy. Retrying in ${left}s (attempt ${round + 1} of ${RETRY_DELAYS_MS.length})…`, { spin: true });
        await sleep(1000);
      }
    }
    for (const m of [...candidates]) {
      setStatus(`Asking ${shortModel(m)} to check the ingredients…${round ? ` (attempt ${round + 1})` : ''}`, { spin: true });
      try {
        return await requestModel(apiKey, m, messages);
      } catch (e) {
        if (e.fatal) throw e;
        errors.set(m, e.message.length > 140 ? e.message.slice(0, 140) + '…' : e.message);
        // A model that doesn't exist or can't take this input won't work on retry either
        if (e.permanent) candidates = candidates.filter((c) => c !== m);
      }
    }
  }
  throw Object.assign(new Error('The free AI models are busy right now.'), { details: [...errors].map(([m, msg]) => `${shortModel(m)}: ${msg}`) });
}

async function requestModel(apiKey, m, messages) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  let res, body;
  try {
    res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': location.origin,
        'X-Title': 'VegiBar',
      },
      body: JSON.stringify({ model: m, messages, temperature: 0.1 }),
    });
    body = await res.json().catch(() => ({}));
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? 'timed out' : 'network error');
  } finally {
    clearTimeout(timer);
  }
  const status = body.error?.code || res.status;
  const message = body.error?.message || `HTTP ${res.status}`;
  if (status === 401) throw Object.assign(new Error('Your OpenRouter API key was rejected (401). Check it in Settings.'), { fatal: true });
  if (status === 402) throw Object.assign(new Error('OpenRouter says your account has a negative credit balance (402). Top up or check your key at openrouter.ai.'), { fatal: true });
  if (!res.ok || body.error) {
    throw Object.assign(new Error(`${status} ${message}`), { permanent: status === 400 || status === 404 });
  }
  const text = body.choices?.[0]?.message?.content;
  const parsed = parseJson(typeof text === 'string' ? text : JSON.stringify(text));
  if (!parsed || !parsed.verdict) throw new Error('did not return valid JSON');
  parsed.model = body.model || m;
  return parsed;
}

function parseJson(text) {
  if (!text) return null;
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/```(?:json)?/g, '');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(cleaned.slice(start, end + 1)); } catch { return null; }
}

function normalizeAnalysis(a) {
  const verdict = ['vegan', 'vegetarian', 'non_vegetarian', 'unknown'].includes(a.verdict) ? a.verdict : 'unknown';
  return {
    verdict,
    confidence: ['high', 'medium', 'low'].includes(a.confidence) ? a.confidence : 'medium',
    summary: String(a.summary || ''),
    flagged: Array.isArray(a.flagged) ? a.flagged.filter((f) => f && f.ingredient) : [],
    ingredientsRead: String(a.ingredients_read || ''),
    productName: String(a.product_name || ''),
    model: a.model,
  };
}

// ---------- Flows ----------
async function analyzeBarcode(code, { fresh = false } = {}) {
  if (!/^\d{6,14}$/.test(code)) {
    setStatus(`"${code}" doesn't look like a product barcode.`, { error: true });
    return;
  }
  const cached = !fresh && cacheGet(code);
  if (cached) {
    setStatus('');
    renderResult(cached.meta, cached.analysis, cached.hints, { cachedAt: cached.at });
    addHistory({ ...cached, at: Date.now() });
    return;
  }
  els.result.hidden = true;
  setStatus(`Looking up ${code} on Open Food Facts…`, { spin: true });
  let product;
  try {
    product = await fetchProduct(code);
  } catch (e) {
    setStatus('Lookup failed: ' + e.message, { error: true });
    return;
  }
  if (!product) {
    setStatus('');
    renderMissing(code, 'This barcode isn\'t in the Open Food Facts database yet.');
    return;
  }
  const ingredients = productIngredients(product);
  const name = product.product_name_en || product.product_name || 'Unnamed product';
  const meta = {
    code, name,
    brand: product.brands || '',
    image: product.image_front_small_url || '',
    nutrition: productNutrition(product),
  };
  if (!ingredients) {
    setStatus('');
    renderMissing(code, `Found “${name}”, but it has no ingredient list in the database.`, meta, productHints(product));
    return;
  }
  await analyzeText(ingredients, meta, productHints(product));
}

async function analyzeText(ingredients, meta, hints = []) {
  const { eggMode } = settings();
  const user = [
    `Product: ${meta.name || 'unknown'}${meta.brand ? ' by ' + meta.brand : ''}`,
    `Ingredients: ${ingredients}`,
    hints.length ? `Database hints: ${hints.join(', ')}` : '',
  ].filter(Boolean).join('\n');
  try {
    const raw = await callOpenRouter([
      { role: 'system', content: systemPrompt(eggMode) },
      { role: 'user', content: user },
    ]);
    const analysis = normalizeAnalysis(raw);
    analysis.ingredientsRead = ingredients;
    finish(meta, analysis, hints);
  } catch (e) {
    handleLlmError(e, () => analyzeText(ingredients, meta, hints));
  }
}

async function analyzePhoto(file, meta = {}) {
  els.result.hidden = true;
  setStatus('Preparing photo…', { spin: true });
  let dataUrl;
  try {
    dataUrl = await downscale(file, 1600);
  } catch {
    setStatus('Could not read that image.', { error: true });
    return;
  }
  const { eggMode } = settings();
  try {
    const raw = await callOpenRouter([
      { role: 'system', content: systemPrompt(eggMode) },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'This is a photo of a food package. Read the ingredient list (and any veg/non-veg marks such as the Indian green/brown dot or a vegan logo) and classify it.' },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      },
    ], { vision: true });
    const analysis = normalizeAnalysis(raw);
    finish({
      code: meta.code || '',
      name: meta.name || analysis.productName || 'Photographed label',
      brand: meta.brand || '',
      image: meta.image || dataUrl,
      nutrition: meta.nutrition || null,
      fromPhoto: true,
    }, analysis, []);
  } catch (e) {
    handleLlmError(e, () => analyzePhoto(file, meta));
  }
}

function handleLlmError(e, retry) {
  if (e.message === 'NO_KEY') {
    setStatus('Add your OpenRouter API key in Settings first.', { error: true });
    openSettings();
    return;
  }
  setStatus(e.message, { error: true });
  if (retry && !e.fatal) {
    const btn = document.createElement('button');
    btn.className = 'link';
    btn.textContent = 'Try again';
    btn.onclick = retry;
    els.status.append(' ', btn);
  }
  if (e.details?.length) {
    const d = document.createElement('details');
    d.className = 'error-details';
    d.innerHTML = `<summary>Details</summary><pre>${esc(e.details.join('\n'))}</pre>`;
    els.status.append(d);
  }
}

function finish(meta, analysis, hints) {
  setStatus('');
  renderResult(meta, analysis, hints);
  // Don't persist a photo's data URL; it would eat the storage quota
  const entry = {
    meta: { ...meta, image: meta.image?.startsWith('data:') ? '' : meta.image },
    analysis, hints, at: Date.now(), eggMode: settings().eggMode,
  };
  addHistory(entry);
  if (meta.code) cachePut(entry);
}

function downscale(file, maxSide) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = reject;
    img.src = url;
  });
}

// ---------- Rendering ----------
function productHeader(meta) {
  const img = meta.image ? `<img src="${esc(meta.image)}" alt="">` : '';
  const sub = [meta.brand, meta.code].filter(Boolean).map(esc).join(' · ');
  return `<div class="product">${img}<div><h2>${esc(meta.name)}</h2><div class="sub">${sub}</div></div></div>`;
}

function nutritionHtml(n) {
  if (!n) return '';
  const fmt = (v) => (v >= 100 ? Math.round(v) : Math.round(v * 10) / 10);
  const badges = [
    n.grade ? `<span class="badge ns-${n.grade}">Nutri‑Score <b>${n.grade.toUpperCase()}</b></span>` : '',
    n.nova ? `<span class="badge nova-${n.nova}" title="1 = unprocessed, 4 = ultra-processed">NOVA <b>${n.nova}</b></span>` : '',
  ].join('');
  const table = n.rows.length ? `
    <details class="nutrition">
      <summary>Nutrition per 100 g</summary>
      <table>${n.rows.map((r) => `
        <tr class="${r.sub ? 'sub' : ''}"><th>${esc(r.label.trim())}</th><td>${fmt(r.value)} ${r.unit}</td></tr>`).join('')}
      </table>
      ${n.serving ? `<p class="foot">Serving size: ${esc(n.serving)}</p>` : ''}
    </details>` : '';
  return `${badges ? `<div class="badges">${badges}</div>` : ''}${table}`;
}

function timeAgo(t) {
  const days = Math.floor((Date.now() - t) / 86400000);
  if (days < 1) return 'today';
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

function renderResult(meta, a, hints, { cachedAt = 0 } = {}) {
  const flags = a.flagged.length
    ? `<ul class="flags">${a.flagged.map((f) => `
        <li class="${esc(f.category)}">
          <span class="cat">${esc(f.category || '')}</span>
          <b>${esc(f.ingredient)}</b>
          <span>${esc(f.reason)}</span>
        </li>`).join('')}</ul>`
    : '<p class="foot">No animal-derived or ambiguous ingredients found.</p>';
  const hintTags = hints.length
    ? `<div class="tags">${hints.map((h) => `<span class="tag">${esc(prettyTag(h))}</span>`).join('')}</div>`
    : '';

  els.result.innerHTML = `
    ${productHeader(meta)}
    <div class="verdict ${a.verdict}">
      <div class="label"><span class="dot"></span>${VERDICT_TEXT[a.verdict]}</div>
      <div class="conf">${esc(a.confidence)} confidence</div>
      <p>${esc(a.summary)}</p>
    </div>
    <div>
      <h3>Why</h3>
      ${flags}
    </div>
    ${nutritionHtml(meta.nutrition)}
    <details>
      <summary>Ingredients${hints.length ? ' & database tags' : ''}</summary>
      <p class="ingredients">${esc(a.ingredientsRead || '—')}</p>
      ${hintTags}
    </details>
    ${cachedAt && meta.code ? `<p class="cached">Saved result from ${timeAgo(cachedAt)}. <button class="link" id="recheckBtn">Re-check</button></p>` : ''}
    <p class="foot">Checked by ${esc(a.model || 'LLM')}${meta.fromPhoto ? ' from a photo' : ' using Open Food Facts data'}. AI can make mistakes — check the pack for allergies or strict diets.</p>
    <button class="btn primary" id="againBtn">Scan another</button>
  `;
  els.result.hidden = false;
  $('againBtn').onclick = () => { els.result.hidden = true; window.scrollTo({ top: 0, behavior: 'smooth' }); startScan(); };
  const recheck = $('recheckBtn');
  if (recheck) recheck.onclick = () => analyzeBarcode(meta.code, { fresh: true });
  els.result.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderMissing(code, message, meta = { code, name: `Barcode ${code}` }, hints = []) {
  els.result.innerHTML = `
    ${productHeader(meta)}
    <p>${esc(message)}</p>
    <button class="btn primary" id="missPhoto">Take a photo of the ingredients</button>
    <p class="foot">…or paste / type the ingredient list:</p>
    <textarea id="missText" placeholder="Wheat flour, sugar, edible vegetable oil, …"></textarea>
    <button class="btn" id="missCheck">Check these ingredients</button>
  `;
  els.result.hidden = false;
  $('missPhoto').onclick = () => { pendingPhotoMeta = meta; els.photoInput.click(); };
  $('missCheck').onclick = () => {
    const text = $('missText').value.trim();
    if (text) { els.result.hidden = true; analyzeText(text, meta, hints); }
  };
  els.result.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ---------- History ----------
function addHistory(entry) {
  const list = store.get('history', []).filter((h) => !(entry.meta.code && h.meta.code === entry.meta.code));
  list.unshift(entry);
  store.set('history', list.slice(0, HISTORY_MAX));
  renderHistory();
}

function renderHistory() {
  const list = store.get('history', []);
  els.historySection.hidden = list.length === 0;
  const colors = { vegan: 'var(--vegan)', vegetarian: 'var(--veg)', non_vegetarian: 'var(--nonveg)', unknown: 'var(--unknown)' };
  els.historyList.innerHTML = list.map((h, i) => `
    <li><button data-i="${i}">
      <span class="pill" style="background:${colors[h.analysis.verdict]}"></span>
      <span class="name">${esc(h.meta.name)}</span>
      <span class="v">${VERDICT_TEXT[h.analysis.verdict]}</span>
    </button></li>`).join('');
}

els.historyList.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-i]');
  if (!btn) return;
  const h = store.get('history', [])[Number(btn.dataset.i)];
  if (h) { setStatus(''); renderResult(h.meta, h.analysis, h.hints || [], { cachedAt: h.at }); }
});

// ---------- Settings ----------
function openSettings() {
  const s = settings();
  els.apiKey.value = s.apiKey;
  els.model.value = store.get('model', '');
  els.settings.querySelector(`input[name=eggMode][value=${s.eggMode}]`).checked = true;
  els.settings.showModal();
}

els.settings.addEventListener('close', () => {
  if (els.settings.returnValue !== 'save') return;
  store.set('apiKey', els.apiKey.value.trim());
  store.set('model', els.model.value.trim());
  store.set('eggMode', els.settings.querySelector('input[name=eggMode]:checked')?.value || 'nonveg');
  setStatus('Settings saved.');
  setTimeout(() => setStatus(''), 1500);
});

els.clearHistory.onclick = () => {
  store.set('history', []);
  store.set('cache', {});
  renderHistory();
  setStatus('History and saved results cleared.');
};

// ---------- Wire up ----------
let pendingPhotoMeta = null;

els.settingsBtn.onclick = openSettings;
els.scanBtn.onclick = () => (stream ? stopScan() : startScan());
els.torchBtn.onclick = toggleTorch;
els.manualBtn.onclick = () => {
  els.manualForm.hidden = !els.manualForm.hidden;
  if (!els.manualForm.hidden) els.manualCode.focus();
};
els.manualForm.onsubmit = (e) => {
  e.preventDefault();
  const code = els.manualCode.value.replace(/\D/g, '');
  if (code) { stopScan(); analyzeBarcode(code); }
};
els.photoBtn.onclick = () => { pendingPhotoMeta = null; els.photoInput.click(); };
els.photoInput.onchange = () => {
  const file = els.photoInput.files?.[0];
  els.photoInput.value = '';
  if (file) { stopScan(); analyzePhoto(file, pendingPhotoMeta || {}); }
};

renderHistory();
if (!settings().apiKey) {
  setStatus('Tip: tap ⚙︎ to add your OpenRouter API key.');
}
