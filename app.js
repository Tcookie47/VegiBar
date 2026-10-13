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
].join(',');
const HISTORY_MAX = 25;

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
const settings = () => ({
  apiKey: store.get('apiKey', ''),
  model: store.get('model', '') || DEFAULT_MODEL,
  eggMode: store.get('eggMode', 'nonveg'),
});

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const els = {
  reader: $('reader'),
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
let scanner = null;
let scanning = false;

async function startScan() {
  if (!window.Html5Qrcode) {
    setStatus('Scanner library failed to load. Check your connection, or type the barcode.', { error: true });
    return;
  }
  if (!window.isSecureContext) {
    setStatus('Camera needs HTTPS. Open this app over https:// (e.g. GitHub Pages).', { error: true });
    return;
  }
  const F = window.Html5QrcodeSupportedFormats;
  if (!scanner) {
    scanner = new Html5Qrcode('reader', {
      verbose: false,
      formatsToSupport: [F.EAN_13, F.EAN_8, F.UPC_A, F.UPC_E, F.CODE_128, F.CODE_39, F.ITF],
      experimentalFeatures: { useBarCodeDetectorIfSupported: true },
    });
  }
  els.placeholder.hidden = true;
  els.reader.hidden = false;
  els.scanBtn.textContent = 'Stop scanning';
  scanning = true;
  setStatus('');
  try {
    await scanner.start(
      { facingMode: 'environment' },
      {
        fps: 12,
        qrbox: (w, h) => ({ width: Math.floor(w * 0.85), height: Math.floor(Math.min(h * 0.5, w * 0.45)) }),
        aspectRatio: 4 / 3,
      },
      onScan,
      () => {},
    );
  } catch (err) {
    await stopScan();
    setStatus('Could not open the camera: ' + (err?.message || err) + '. You can type the barcode instead.', { error: true });
  }
}

async function stopScan() {
  scanning = false;
  els.scanBtn.textContent = 'Scan barcode';
  try { if (scanner?.isScanning) await scanner.stop(); } catch {}
  els.reader.hidden = true;
  els.placeholder.hidden = false;
}

async function onScan(code) {
  if (!scanning) return;
  scanning = false;
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

async function callOpenRouter(messages, { vision = false } = {}) {
  const { apiKey, model } = settings();
  if (!apiKey) throw new Error('NO_KEY');
  const candidates = [...new Set([model, ...(vision ? VISION_FALLBACK_MODELS : FALLBACK_MODELS)])];
  const errors = [];
  for (const m of candidates) {
    setStatus(`Asking ${m} to check the ingredients…`, { spin: true });
    try {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': location.origin,
          'X-Title': 'VegiBar',
        },
        body: JSON.stringify({ model: m, messages, temperature: 0.1 }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.status === 401) throw Object.assign(new Error('Invalid OpenRouter API key (401).'), { fatal: true });
      if (!res.ok || body.error) throw new Error(body.error?.message || `HTTP ${res.status}`);
      const text = body.choices?.[0]?.message?.content;
      const parsed = parseJson(typeof text === 'string' ? text : JSON.stringify(text));
      if (!parsed || !parsed.verdict) throw new Error('Model did not return valid JSON');
      parsed.model = body.model || m;
      return parsed;
    } catch (e) {
      if (e.fatal) throw e;
      errors.push(`${m}: ${e.message}`);
    }
  }
  throw new Error('All models failed:\n' + errors.join('\n'));
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
async function analyzeBarcode(code) {
  if (!/^\d{6,14}$/.test(code)) {
    setStatus(`"${code}" doesn't look like a product barcode.`, { error: true });
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
  const meta = { code, name, brand: product.brands || '', image: product.image_front_small_url || '' };
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
    handleLlmError(e);
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
      fromPhoto: true,
    }, analysis, []);
  } catch (e) {
    handleLlmError(e);
  }
}

function handleLlmError(e) {
  if (e.message === 'NO_KEY') {
    setStatus('Add your OpenRouter API key in Settings first.', { error: true });
    openSettings();
    return;
  }
  setStatus(e.message, { error: true });
}

function finish(meta, analysis, hints) {
  setStatus('');
  renderResult(meta, analysis, hints);
  addHistory({ meta: { ...meta, image: meta.fromPhoto ? '' : meta.image }, analysis, hints, at: Date.now() });
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

function renderResult(meta, a, hints) {
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
    <details>
      <summary>Ingredients${hints.length ? ' & database tags' : ''}</summary>
      <p class="ingredients">${esc(a.ingredientsRead || '—')}</p>
      ${hintTags}
    </details>
    <p class="foot">Checked by ${esc(a.model || 'LLM')}${meta.fromPhoto ? ' from a photo' : ' using Open Food Facts data'}. AI can make mistakes — check the pack for allergies or strict diets.</p>
    <button class="btn primary" id="againBtn">Scan another</button>
  `;
  els.result.hidden = false;
  $('againBtn').onclick = () => { els.result.hidden = true; window.scrollTo({ top: 0, behavior: 'smooth' }); startScan(); };
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
  if (h) { setStatus(''); renderResult(h.meta, h.analysis, h.hints || []); }
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

els.clearHistory.onclick = () => { store.set('history', []); renderHistory(); };

// ---------- Wire up ----------
let pendingPhotoMeta = null;

els.settingsBtn.onclick = openSettings;
els.scanBtn.onclick = () => (scanning ? stopScan() : startScan());
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
