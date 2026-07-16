# Vendored third-party assets

These files are served locally (from R2/Workers static assets) instead of a CDN, so the app
has **no external runtime dependencies** — it keeps working if cdnjs / Google Fonts are
unreachable, blocked by a network policy, or down. Nothing here is edited by hand; each file is
copied verbatim from its npm package.

| File(s)                     | Source package (version)          |
| --------------------------- | --------------------------------- |
| `pdf-lib.min.js`            | `pdf-lib` 1.17.1                   |
| `pdf.min.mjs`               | `pdfjs-dist` 6.1.200 (`build/`)   |
| `pdf.worker.min.mjs`        | `pdfjs-dist` 6.1.200 (`build/`)   |
| `fonts/*.woff2`, `fonts.css`| `@fontsource/hanken-grotesk` 5.x  |
| `tesseract/tesseract.esm.min.js`, `tesseract/worker.min.js` | `tesseract.js` 5.x |
| `tesseract/tesseract-core-simd-lstm.wasm{,.js}` | `tesseract.js-core` 5.x |
| `tesseract/eng.traineddata.gz` | `@tesseract.js-data/eng` (the smaller `4.0.0_best_int` model) |

All three are pinned as `devDependencies` in `package.json` purely to track provenance and make
re-vendoring reproducible — they are **not** loaded from `node_modules` at runtime.

## Re-vendoring (e.g. to bump a version)

```bash
npm install --save-dev pdfjs-dist@<version> pdf-lib@<version> @fontsource/hanken-grotesk@<version>
cp node_modules/pdf-lib/dist/pdf-lib.min.js            public/vendor/pdf-lib.min.js
cp node_modules/pdfjs-dist/build/pdf.min.mjs           public/vendor/pdf.min.mjs
cp node_modules/pdfjs-dist/build/pdf.worker.min.mjs    public/vendor/pdf.worker.min.mjs
for w in 400 500 600 700; do
  cp node_modules/@fontsource/hanken-grotesk/files/hanken-grotesk-latin-$w-normal.woff2 public/vendor/fonts/
done
```

```bash
# OCR (Edit-text tool):
npm install --save-dev tesseract.js@5 tesseract.js-core@5 @tesseract.js-data/eng
cp node_modules/tesseract.js/dist/tesseract.esm.min.js            public/vendor/tesseract/
cp node_modules/tesseract.js/dist/worker.min.js                    public/vendor/tesseract/
cp node_modules/tesseract.js-core/tesseract-core-simd-lstm.wasm{,.js} public/vendor/tesseract/
cp node_modules/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz public/vendor/tesseract/
```

If you bump the pdf.js major version, re-check the API calls in `public/app.js` and
`public/sign.html` (they use `getDocument`, `getPage`, `getViewport`, `page.render`). The
Tesseract worker/core/lang paths are configured in `getOcrWorker()` in `public/app.js`.
