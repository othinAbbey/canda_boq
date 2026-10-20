# canda-boq-service

The drawing reader. It takes a PDF, sends it straight to the AI provider (Anthropic, OpenAI or Gemini), checks the quantities,
prices them from the rate book and builds an Excel BOQ.

**This is an internal worker, not a public service.** Users never talk to it. They use the C & A API (`canda-api`), which
stores every drawing and result in PostgreSQL under the user who uploaded it and calls this service on their behalf.
Set `BOQ_SERVICE_KEY` here and the same value in the API's `.env`; without it anyone who can reach this port can spend your AI credit.
Keep the port closed to the internet (firewall, private network, or `127.0.0.1` only).

    npm install
    copy .env.example .env        # set AI_PROVIDER, that provider's key and model, BOQ_SERVICE_KEY
    npm start                     # http://127.0.0.1:8000
    npm test

---

# Backend - Drawing PDF -> Claude -> Excel BOQ

Upload a drawing PDF. The backend sends the **whole PDF straight to the Claude API**
(Claude reads the text and the page images), gets back every drawing with its rooms,
door/window schedule and notes, then **checks the data, calculates the quantities,
applies your rates and writes an Excel file**.

No npm packages are needed. Node 20 or newer.

## AI providers
The whole PDF is sent **as the original PDF file** to the provider (no local text extraction or
page-to-image conversion). Choose the provider in `.env` (copy `.env.example`):

| `AI_PROVIDER` | Key variable | How the PDF is sent |
|---|---|---|
| `anthropic` | `ANTHROPIC_API_KEY` | `document` block, base64 PDF (Messages API) |
| `openai` | `OPENAI_API_KEY` | `input_file` with a base64 PDF data URL (Responses API) |
| `gemini` | `GEMINI_API_KEY` | `inline_data`, `application/pdf` (generateContent) |

Set `*_MODEL` to a model that accepts PDFs and structured JSON output. To switch providers, change
`AI_PROVIDER` and restart. To add another provider, write an adapter like `gemini/pdfReader.js`
and add it to `providers/index.js` and `SUPPORTED` in `config.js`.

## Run
    node server.js                                  # http://127.0.0.1:8000

On a host (Render, Railway, a VPS): start command `node server.js`, and set
`HOST=0.0.0.0`, `ANTHROPIC_API_KEY`, and `BOQ_CORS_ORIGINS=https://your-frontend-url`.
Jobs are stored in `data/`, so use a host with a persistent disk.

**Anyone who can reach this API can spend your Anthropic credit.** Put authentication in
front of it before exposing it to the internet.

## What happens to a PDF
1. `POST /api/jobs` uploads it and returns a job id at once (a read can take minutes).
2. Claude reads the PDF (one streamed API call; `claude/pdfReader.js`).
3. `validate/checks.js` flags problems; `takeoff/quantities.js` calculates quantities from the
   rooms and openings (plain arithmetic, no AI); `pricing/` applies `rates.csv`;
   `boq/exportXlsx.js` writes the workbook.
4. Poll `GET /api/jobs/{id}` until `status` is `done` or `failed`; download the Excel file.

The model is never asked for quantities or prices. It only reports what the drawings show; every
number in the BOQ is traceable to a room/opening it read (see the *Rooms read*, *Openings read* and
*Notes read* sheets, and the *Basis* column).

## Excel workbook
BOQ (amounts and totals are live formulas; yellow cells are inputs) - Unpriced - Issues -
Rooms read - Openings read - Notes read.

## Settings (environment variables)
| Name | Default | Purpose |
|---|---|---|
| AI_PROVIDER | - | `anthropic`, `openai` or `gemini` |
| ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY | - | key for the chosen provider (or AI_API_KEY) |
| ANTHROPIC_MODEL / OPENAI_MODEL / GEMINI_MODEL | - | model for the chosen provider (or AI_MODEL) |
| BOQ_MAX_TOKENS | 16000 | output budget for one reply covering the whole set |
| BOQ_MAX_PDF_MB | 20 | upload limit (the API request limit is 32 MB, base64 adds a third) |
| BOQ_MAX_JOBS | 2 | jobs calling the API at once; others wait |
| BOQ_CORS_ORIGINS | - | comma-separated front-end URLs allowed to call the API |
| BOQ_CURRENCY, BOQ_PRICE_IN, BOQ_PRICE_OUT | UGX, 2, 10 | currency label; USD per million tokens for the cost estimate |
| BOQ_DATA, BOQ_RATES, BOQ_ASSUMPTIONS, BOQ_CACHE, BOQ_JOBS | see config.js | file locations |
| HOST, PORT | 127.0.0.1, 8000 | where to listen |
| BOQ_API_IDLE_TIMEOUT_S | 120 | give up if the API sends nothing for this long |

## Rates and assumptions
`pricing/rates.csv` starts with blank rates: a blank rate leaves the line **unpriced** (nothing is
ever guessed). Edit it on the front end's Rates tab or in the file. `takeoff/assumptions.toml` holds
waste %, wall heights, which rooms get which floor finish, excluded rooms (stairs/voids) and the
preliminaries/contingency/tax %. After changing either, press *Rebuild with current rates*
(`POST /api/jobs/{id}/rebuild`): it recalculates from the saved reading and **does not call the API again**.

## Cost control
- The same PDF (same bytes, model and prompt) is never paid for twice: answers are cached in `data/cache/`.
  `?force=true` on the upload reads it again.
- A failed read that returned nothing is not cached and costs nothing to retry.

## Limits to know about
- Claude's PDF input accepts up to 100 pages per request and 32 MB. Very large sheets (A1/A0) are
  downscaled by the API, so small dimension text can be misread. Check the *Issues* sheet and
  spot-check dimensions against the drawings; low-confidence rooms are flagged.
- One reply has to hold every drawing. If it is cut off you get a clear error: raise `BOQ_MAX_TOKENS`
  or upload fewer pages.
- Version 1 measures finishes and openings only (floors, skirting, ceilings, plaster, paint,
  doors, windows). Structure is not measured.

## API (all under /api)
POST /jobs (multipart field `file`, optional `?force=true`) - GET /jobs - GET /jobs/{id} -
POST /jobs/{id}/rebuild - GET /jobs/{id}/extraction - GET /jobs/{id}/boq.xlsx -
GET|PUT /rates - GET /assumptions - GET /config - GET /usage - GET /health

## Tests
    node --test tests/e2e.test.js   # 23 end-to-end tests against a mock Claude API



