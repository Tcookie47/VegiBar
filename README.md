# VegiBar

A phone-first web app that scans a product barcode and tells you whether it is
**vegan**, **vegetarian** or **non-veg**, with a justification that names the
ingredients that decided it.

## How it works

1. **Scan** – the phone camera reads the barcode (EAN/UPC/Code128) using
   [html5-qrcode](https://github.com/mebjas/html5-qrcode), which uses the
   native `BarcodeDetector` where the browser has one.
2. **Look up** – the ingredient list, labels and allergens come from
   [Open Food Facts](https://world.openfoodfacts.org) (free, no key).
3. **Reason** – the ingredients go to a free LLM on
   [OpenRouter](https://openrouter.ai) with your API key. It returns a verdict,
   a confidence level, a short justification and a list of every animal-derived
   or ambiguous ingredient (e.g. E471, gelatin, whey, carmine) with the reason.
4. **Not in the database?** Take a photo of the ingredient panel. A free vision
   model reads it and classifies it the same way. You can also paste the
   ingredients as text.

Everything runs in the browser; there is no server. Your API key is kept in
`localStorage` on your phone and is only sent to `openrouter.ai`.

## Settings (⚙︎)

- **OpenRouter API key** – create one at <https://openrouter.ai/keys>. Setting a
  low credit limit on the key is a good idea since it lives in the browser.
- **Model** – defaults to `openrouter/free` (OpenRouter's router across free
  models). Put any model id here; if it errors, a list of free fallbacks is
  tried in order (`FALLBACK_MODELS` / `VISION_FALLBACK_MODELS` in `app.js`).
- **Eggs count as** – non-veg (Indian convention, the default) or vegetarian
  (Western convention).

## Running it

The camera only works over **HTTPS** (or `localhost`).

**GitHub Pages (recommended):** in the repo go to *Settings → Pages → Source:
GitHub Actions*. Every push to `main` deploys via `.github/workflows/pages.yml`
to `https://<user>.github.io/<repo>/`. Open it on your phone and use *Add to
Home Screen* for an app-like icon.

**Locally:**

```sh
python3 -m http.server 8000
# open http://localhost:8000 on this machine
```

To test on a phone against your laptop you need HTTPS, e.g. a tunnel like
`npx localtunnel --port 8000` or `cloudflared tunnel --url http://localhost:8000`.

## Caveats

AI can be wrong, and "natural flavours", E471 and similar additives can come
from plants or animals. The app flags those as ambiguous and lowers its
confidence. For allergies or strict religious diets, check the pack.
