
# CA BOQ — AI-Powered PDF-to-BOQ System

## 1. Project Overview

CA BOQ processes construction drawing PDFs using AI to extract structured drawing information and feed the existing quantity take-off and Bill of Quantities (BOQ) workflow.

The intended system supports multiple AI providers through a common interface. Each provider has its own adapter, while the BOQ calculation and Excel generation processes remain shared.

### Main objectives

- Accept architectural and engineering drawing PDFs.
- Send original PDF bytes to a configured AI provider.
- Extract structured drawing information using a shared schema.
- Validate and normalize the extracted information.
- Feed validated data into the existing BOQ pipeline.
- Calculate quantities and apply project rates and assumptions.
- Generate BOQ Excel workbooks.
- Track processing status, AI usage, estimated costs, and cached results.
- Support additional AI providers without rewriting the whole application.

**Important:** The provider registry currently supports Anthropic/Claude. Other providers must have working adapters and tests before they can be selected.

---

## 2. Project Architecture

```text
Frontend / Client
       |
       | Upload PDF
       | Select provider/model (if enabled)
       v
Backend API
       |
       v
Service Layer
       |
       +---- Configuration (.env)
       |
       +---- Provider Registry
       |          |
       |          +---- Claude PDF Reader
       |          +---- Future OpenAI Reader
       |          +---- Future Gemini Reader
       |
       v
AI Provider API
       |
       | Original PDF bytes
       v
Structured AI Response
       |
       v
Shared Document Schema
       |
       v
Validation and Normalization
       |
       v
BOQ Quantity Take-Off
       |
       +---- Project Rates
       +---- Assumptions
       |
       v
Excel BOQ Generation
       |
       v
Client Receives Results
```

The AI provider is responsible for interpreting the PDF and returning structured data. The existing BOQ pipeline remains responsible for processing the validated data into quantities and BOQ outputs.

---

## 3. Core File Structure

The following is the known core structure. Preserve other existing project files and directories.

```text
backend/
│
├── .env
├── .env.example
├── .gitignore
├── package.json
│
├── config.js
├── service.js
│
├── providers/
│   └── index.js
│
├── claude/
│   └── pdfReader.js
│
├── documentSchema.js
├── prompts.js
├── schemas.js
│
├── data/
│   ├── jobs/
│   ├── cache/
│   ├── rates.json
│   └── assumptions.json
│
└── tests/
    └── Existing and future tests
```

### Responsibilities

| File | Responsibility |
|---|---|
| `config.js` | Loads and validates environment variables. |
| `service.js` | Coordinates jobs, PDF processing, and the BOQ workflow. |
| `providers/index.js` | Selects the configured AI provider adapter. |
| `claude/pdfReader.js` | Sends PDFs to Anthropic and processes the response. |
| `documentSchema.js` | Defines the shared structured document output. |
| `prompts.js` | Contains shared AI extraction instructions. |
| `schemas.js` | Contains related schema definitions or validation logic. |
| `.env` | Stores backend configuration and secrets. |
| `rates.json` | Contains configured BOQ rates, where used. |
| `assumptions.json` | Contains quantity take-off assumptions, where used. |

The actual locations of the rates, assumptions, jobs, and cache directories must match the paths configured in your project.

---

## 4. System Processing Flow

### Step 1: Receive the PDF

The client uploads a construction drawing PDF to the backend.

The backend validates the upload and creates a processing job.

### Step 2: Load configuration

The backend reads its configuration from `.env`.

This includes the provider, API key, API base URL, model, timeouts, retry limits, and BOQ settings.

### Step 3: Select the provider

The provider registry creates the appropriate PDF reader based on the configured provider.

### Step 4: Send the original PDF

The selected adapter sends the PDF bytes directly to the provider using that provider's documented API format.

Provider-specific request formats are handled inside the adapter.

### Step 5: Extract structured information

The AI returns drawing information in the format expected by the shared document schema.

### Step 6: Validate the response

The service validates and normalizes the response using the existing document-processing logic.

Invalid or incomplete results should be reported rather than silently treated as correct.

### Step 7: Generate the BOQ

The existing pipeline processes the extracted data using project rates and assumptions, then generates the BOQ workbook.

### Step 8: Return the result

The client receives the job status and the available outputs.

Engineering review remains necessary before relying on extracted dimensions, quantities, assumptions, or final prices.

---

## 5. Environment Setup

### Requirements

- Node.js compatible with the project.
- npm.
- An API key for an implemented AI provider.
- Existing BOQ rates and assumptions files required by the project.

### Install dependencies

Open PowerShell:

```powershell
cd D:\CA_BOQ_JS\backend
npm install
```

If a valid `package-lock.json` is present and you want a clean reproducible installation, use:

```powershell
npm ci
```

### Configure `.env`

Create or update `.env` in the backend directory.

```dotenv
# AI provider
AI_PROVIDER=anthropic
AI_API_KEY=your_api_key
AI_BASE_URL=https://api.anthropic.com
AI_MODEL=your_supported_model

# Request behaviour
AI_TIMEOUT_MS=120000
AI_MAX_RETRIES=2
BOQ_MAX_TOKENS=8192

# BOQ settings
BOQ_MAX_PDF_MB=25
BOQ_MAX_JOBS=2

BOQ_JOBS=./data/jobs
BOQ_CACHE=./data/cache
BOQ_RATES=./data/rates.json
BOQ_ASSUMPTIONS=./data/assumptions.json

# Usage and cost settings
BOQ_PRICE_IN=0
BOQ_PRICE_OUT=0
BOQ_CURRENCY=UGX

# Frontend origins allowed by the backend
BOQ_CORS_ORIGINS=http://localhost:3000
```

These are example values, not a replacement for checking the existing `config.js` and `.env`.

- Use a model identifier supported by your provider account.
- Use the API base URL expected by the selected adapter.
- Configure the correct input and output token prices if cost tracking depends on them.
- Confirm the required CORS origins and file paths.
- Never commit `.env` or expose API keys to the browser.

The `.env` file should be excluded by `.gitignore`. Commit `.env.example` with placeholder values instead.

### Run tests

```powershell
npm test
```

The last reported test run passed 23 tests. Run the suite again after every implementation change.

### Find available start commands

```powershell
npm run
```

Use the development or production command actually declared in `package.json`.

---

## 6. The Provider Adapter Contract

Every provider adapter should implement the same interface:

```javascript
read(pdfBuffer, filename, useCache)
  -> { raw, usage, cached }
```

### Input values

- `pdfBuffer`: the original PDF bytes.
- `filename`: the original filename.
- `useCache`: whether a previous result may be reused.

### Returned values

- `raw`: structured extraction data.
- `usage`: provider usage information, where available.
- `cached`: whether the result was served from cache.

The service should not need to know the provider's internal API format.

For example, the Claude adapter can use Anthropic's document format, while a future OpenAI adapter can use OpenAI's supported PDF input format. Both must normalize their results to the same application contract.

Do not force local PDF text extraction to be a prerequisite for the general AI reader.

---

## 7. How to Add More AI Providers

Each provider needs a separate adapter.

Example future structure:

```text
providers/
├── index.js
├── openaiPdfReader.js
├── geminiPdfReader.js
└── otherPdfReader.js
```

These future files should only be added when implementing the corresponding providers.

### Implementation process

1. Check the provider's current official API documentation.
2. Confirm direct PDF input support and the required request format.
3. Implement the common `read()` interface.
4. Authenticate using server-side configuration.
5. Send the original PDF bytes using the documented API.
6. Reuse the shared prompt and schema wherever supported.
7. Normalize the response into the structure expected by `buildDoc()`.
8. Handle timeouts, retries, caching, errors, and usage reporting.
9. Register the adapter in `providers/index.js`.
10. Write tests using a mocked API.
11. Run the full test suite.
12. Test with a representative drawing before enabling the provider for clients.

Cache keys should account for the provider, model, prompt version, and schema version. This helps prevent one provider's result from being reused incorrectly by another.

Do not assume that changing `AI_PROVIDER` alone enables a new provider. Its adapter must exist and be registered.

---

## 8. Can Clients Select the AI Provider?

**Yes.** There are two approaches.

### Option A: Administrator selects the provider

The administrator configures the backend `.env`.

```dotenv
AI_PROVIDER=anthropic
AI_MODEL=your_supported_model
```

All client requests use that configured provider.

Advantages:

- Simple to implement.
- Easier to control API costs.
- No provider-selection interface is required.
- API credentials remain on the server.

This is suitable for the first working release.

### Option B: Client selects the provider and model

The frontend displays a dropdown containing only enabled providers and supported models.

For example:

```text
Choose AI Provider

[ Anthropic / Claude       v ]

Choose Model

[ Available model          v ]

[ Upload PDF and Process ]
```

The client sends the selected provider and model identifiers with the upload request.

The backend must then:

1. Confirm the provider is implemented.
2. Confirm it is enabled.
3. Validate the requested model against an allowlist.
4. Select credentials from backend configuration.
5. Create the appropriate adapter.
6. Process the PDF.
7. Record provider, model, usage, cost, and job status.

The client must never send or receive the server's API key.

### Recommended design

Create a backend endpoint such as:

```text
GET /api/ai/providers
```

It should return only the providers and models currently enabled by the server.

Example response:

```json
{
  "providers": [
    {
      "id": "anthropic",
      "name": "Anthropic",
      "models": [
        {
          "id": "configured-model-id",
          "name": "Configured model"
        }
      ]
    }
  ]
}
```

This is an illustrative response, not an endpoint that already exists.

When additional providers are implemented and enabled, the endpoint can return them automatically. The frontend can then populate its dropdown from the endpoint instead of hardcoding provider names.

### Important security rules

- Never expose API keys in frontend code.
- Never trust a provider or model name supplied by a client without validation.
- Do not allow unrestricted client-supplied API URLs.
- Apply authorization, rate limits, concurrency limits, and usage tracking.
- Return a clear error when a provider or model is unavailable.
- If users are allowed to supply their own API keys, treat that as a separate secure feature.

---

## 9. Recommended Implementation Order

1. Keep the existing Claude implementation working.
2. Finalize and test the shared provider interface.
3. Implement a second provider adapter.
4. Add provider-specific configuration and tests.
5. Add the backend endpoint listing enabled providers and models.
6. Add the frontend provider/model dropdown.
7. Validate all client selections on the backend.
8. Track usage and costs by provider and model.
9. Test the complete PDF-to-BOQ workflow.

This order avoids building a frontend selector for providers that cannot yet process PDFs.

---

## 10. Testing and Quality Control

Before releasing a provider, test:

- Valid PDF input.
- Invalid or oversized PDFs.
- Provider authentication failures.
- API timeouts and retry behaviour.
- Invalid or incomplete structured output.
- Cache hits and cache misses.
- Usage metadata and cost calculations.
- BOQ generation and Excel output.
- Attempts to request a disabled provider or unsupported model.

AI-generated drawing interpretations and quantities should be checked against the source drawing. The software must not silently present uncertain extraction results as verified engineering quantities.

---

## 11. Current Implementation Status

Based on the latest reported development state:

### Implemented

- Environment-based configuration.
- Provider registry.
- Anthropic/Claude PDF reader.
- Direct PDF-byte submission in the Claude adapter.
- Shared structured-output validation in the service workflow.
- Existing tests: 23 passing at the last reported run.

### Not yet confirmed as implemented

- OpenAI adapter.
- Google Gemini adapter.
- Other provider adapters.
- Public endpoint for enabled providers and models.
- Frontend provider/model selection.
- Per-client provider permissions or bring-your-own-key support.

The project should expose only the providers that have been implemented, tested, and enabled.
