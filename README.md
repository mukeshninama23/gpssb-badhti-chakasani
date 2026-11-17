# બઢતી ફાઈલ ચકાસણી (hosted)

Upload a scanned District Panchayat promotion proposal PDF, let Claude scrutinise it, and download a Gujarati Excel workbook (ZIP with page images and page links).

- `index.html` – the page (PDF rendering, results, Excel/ZIP building all run in the browser).
- `server.js` – serves the page and relays Claude requests to the Anthropic API. No dependencies.

Render settings: build `echo build-ok`, start `node server.js`. Environment: `ANTHROPIC_API_KEY` (required), `ACCESS_CODE` (required), optional `MODEL_DEFAULT`, `MODEL_COMPLEX`, `MODEL_QUICK`, `MAX_ACTIVE`.
