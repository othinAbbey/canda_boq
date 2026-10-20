// /**
//  * Central settings. Every value can be overridden with an environment variable.
//  * The API key is NOT stored here: it is read from ANTHROPIC_API_KEY.
//  * Check the current model names in Anthropic's docs before you ship.
//  */
// import path from "node:path";
// import { fileURLToPath } from "node:url";

// export const ROOT = path.dirname(fileURLToPath(import.meta.url));

// const int = (v, d) => (v === undefined || v === "" ? d : parseInt(v, 10));
// const float = (v, d) => (v === undefined || v === "" ? d : parseFloat(v));

// export function loadSettings(env = process.env) {
//   const dataDir = env.BOQ_DATA || path.join(ROOT, "data");
//   return Object.freeze({
//     model: env.BOQ_MODEL || "claude-sonnet-5-5",
//     // Output budget for ONE reply covering the whole drawing set.
//     maxTokens: int(env.BOQ_MAX_TOKENS, 16000),

//     // The API accepts requests up to 32 MB; base64 makes a PDF about a third bigger.
//     maxPdfMb: float(env.BOQ_MAX_PDF_MB, 20),
//     // Jobs that call the API at the same time (the rest wait in a queue).
//     maxConcurrentJobs: int(env.BOQ_MAX_JOBS, 2),

//     jobsDir: env.BOQ_JOBS || path.join(dataDir, "jobs"),
//     cacheDir: env.BOQ_CACHE || path.join(dataDir, "cache"),
//     ratesPath: env.BOQ_RATES || path.join(ROOT, "pricing", "rates.csv"),
//     assumptionsPath: env.BOQ_ASSUMPTIONS || path.join(ROOT, "takeoff", "assumptions.toml"),

//     // Only used to show an estimated cost. Check Anthropic's pricing page and
//     // set these to the model you use (USD per million tokens).
//     priceInPerMtok: float(env.BOQ_PRICE_IN, 2.0),
//     priceOutPerMtok: float(env.BOQ_PRICE_OUT, 10.0),

//     currency: env.BOQ_CURRENCY || "UGX",
//     BOQ_CORS_ORIGINS: env.BOQ_CORS_ORIGINS || "http://localhost:3000"
//   });
// }

// export const SETTINGS = loadSettings();


/**
 * Central application settings.
 * All configuration values must come from environment variables.
 * Never expose API keys through public endpoints or logs.
 */

/**
 * Central application settings.
 * Production configuration is loaded from .env through dotenv.
 * Explicitly supplied values override process environment values,
 * which allows tests to supply controlled configuration.
 *
 * Never expose API keys through public endpoints or logs.
 */

////////////////////////////////////////////////
// import "dotenv/config";
// import path from "node:path";
// import { fileURLToPath } from "node:url";

// export const ROOT = path.dirname(fileURLToPath(import.meta.url));

// function required(env, name) {
//   const value = env[name]?.trim();

//   if (!value) {
//     throw new Error(`Missing required environment variable: ${name}`);
//   }

//   return value;
// }

// function positiveNumber(env, name, integer = false) {
//   const value = required(env, name);
//   const parsed = Number(value);

//   if (
//     !Number.isFinite(parsed) ||
//     parsed <= 0 ||
//     (integer && !Number.isSafeInteger(parsed))
//   ) {
//     throw new Error(
//       `${name} must be a positive ${integer ? "integer" : "number"}`
//     );
//   }

//   return parsed;
// }

// function nonNegativeInteger(env, name) {
//   const value = required(env, name);
//   const parsed = Number(value);

//   if (!Number.isSafeInteger(parsed) || parsed < 0) {
//     throw new Error(`${name} must be a non-negative integer`);
//   }

//   return parsed;
// }

// export function loadSettings(overrides = process.env) {
//   // Explicit overrides take priority over values loaded from .env.
//   const env = { ...process.env, ...overrides };

//   // Validate that the data directory is configured, even though the
//   // individual jobs/cache paths are configured separately.
//   required(env, "BOQ_DATA");

//   return Object.freeze({
//     // AI provider configuration
//     aiProvider: required(env, "AI_PROVIDER").toLowerCase(),
//     apiKey: (env.AI_API_KEY ?? "").trim(),
//     baseUrl: required(env, "AI_BASE_URL").replace(/\/+$/, ""),
//     model: required(env, "AI_MODEL"),
//     timeoutMs: positiveNumber(env, "AI_TIMEOUT_MS", true),
//     maxRetries: nonNegativeInteger(env, "AI_MAX_RETRIES"),

//     // PDF and job processing
//     maxTokens: positiveNumber(env, "BOQ_MAX_TOKENS", true),
//     maxPdfMb: positiveNumber(env, "BOQ_MAX_PDF_MB"),
//     maxConcurrentJobs: positiveNumber(env, "BOQ_MAX_JOBS", true),

//     // Application paths
//     jobsDir: required(env, "BOQ_JOBS"),
//     cacheDir: required(env, "BOQ_CACHE"),
//     ratesPath: required(env, "BOQ_RATES"),
//     assumptionsPath: required(env, "BOQ_ASSUMPTIONS"),

//     // Estimated API costs
//     priceInPerMtok: positiveNumber(env, "BOQ_PRICE_IN"),
//     priceOutPerMtok: positiveNumber(env, "BOQ_PRICE_OUT"),

//     // Application settings
//     currency: required(env, "BOQ_CURRENCY"),
//     BOQ_CORS_ORIGINS: required(env, "BOQ_CORS_ORIGINS"),
//   });
// }

// export const SETTINGS = loadSettings();
//////////////////////////////////////////////////////

/**
 * Central application settings.
 * Provider-specific environment variables take priority over shared AI_* values.
 * Never expose API keys through public endpoints or logs.
 */
import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SUPPORTED = ["anthropic", "openai", "gemini"];

export const ROOT = path.dirname(fileURLToPath(import.meta.url));

function required(env, name) {
  const value = env[name]?.trim();

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function firstConfigured(...values) {
  return values.find(
    (value) => typeof value === "string" && value.trim() !== ""
  )?.trim();
}


function resolveApiKey(env, supplied, explicitOverrides, providerKeyName) {
  // Explicit provider-specific overrides take priority,
  // even when the supplied key is an empty string.
  if (explicitOverrides && Object.hasOwn(supplied, providerKeyName)) {
    return (supplied[providerKeyName] ?? "").trim();
  }

  // Respect an explicitly supplied shared key, including an empty value.
  if (explicitOverrides && Object.hasOwn(supplied, "AI_API_KEY")) {
    return (supplied.AI_API_KEY ?? "").trim();
  }

  return firstConfigured(
    env[providerKeyName],
    env.AI_API_KEY
  ) ?? "";
}


function positiveNumber(env, name, integer = false) {
  const value = required(env, name);
  const parsed = Number(value);

  if (
    !Number.isFinite(parsed) ||
    parsed <= 0 ||
    (integer && !Number.isSafeInteger(parsed))
  ) {
    throw new Error(
      `${name} must be a positive ${integer ? "integer" : "number"}`
    );
  }

  return parsed;
}

function nonNegativeInteger(env, name) {
  const value = required(env, name);
  const parsed = Number(value);

  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }

  return parsed;
}


export function loadSettings(overrides) {
  const explicitOverrides = overrides !== undefined;
  const supplied = overrides ?? process.env;

  // Explicit overrides take priority over process.env.
  const env = { ...process.env, ...supplied };


  required(env, "BOQ_DATA");

  const aiProvider = required(env, "AI_PROVIDER").toLowerCase();

  if (!SUPPORTED.includes(aiProvider)) {
    throw new Error(
      `Unsupported AI provider: "${aiProvider}". ` +
      `Supported providers: ${SUPPORTED.join(", ")}.`
    );
  }

  // Per provider: its own env names, then the shared AI_* values, then a default URL.
  const PROVIDERS = {
    openai:    { key: "OPENAI_API_KEY",    url: "OPENAI_BASE_URL",    model: "OPENAI_MODEL",    defaultUrl: "https://api.openai.com/v1" },
    anthropic: { key: "ANTHROPIC_API_KEY", url: "ANTHROPIC_BASE_URL", model: "ANTHROPIC_MODEL", defaultUrl: "https://api.anthropic.com" },
    gemini:    { key: "GEMINI_API_KEY",    url: "GEMINI_BASE_URL",    model: "GEMINI_MODEL",    defaultUrl: "https://generativelanguage.googleapis.com/v1beta" },
  };
  const P = PROVIDERS[aiProvider];

  const providerConfig = {
    apiKey: resolveApiKey(env, supplied, explicitOverrides, P.key),
    baseUrl: firstConfigured(env[P.url], env.AI_BASE_URL, P.defaultUrl),
    model: firstConfigured(env[P.model], env.AI_MODEL),
  };

  if (!providerConfig.model) {
    throw new Error(
      `Missing required environment variable: ${P.model} or AI_MODEL`
    );
  }

  return Object.freeze({
    // AI provider configuration
    aiProvider,
    apiKey: providerConfig.apiKey,
    baseUrl: providerConfig.baseUrl.replace(/\/+$/, ""),
    model: providerConfig.model,
    timeoutMs: positiveNumber(env, "AI_TIMEOUT_MS", true),
    maxRetries: nonNegativeInteger(env, "AI_MAX_RETRIES"),

    // PDF and job processing
    maxTokens: positiveNumber(env, "BOQ_MAX_TOKENS", true),
    maxPdfMb: positiveNumber(env, "BOQ_MAX_PDF_MB"),
    maxConcurrentJobs: positiveNumber(env, "BOQ_MAX_JOBS", true),

    // Application paths
    jobsDir: required(env, "BOQ_JOBS"),
    cacheDir: required(env, "BOQ_CACHE"),
    ratesPath: required(env, "BOQ_RATES"),
    assumptionsPath: required(env, "BOQ_ASSUMPTIONS"),

    // Estimated API costs
    priceInPerMtok: positiveNumber(env, "BOQ_PRICE_IN"),
    priceOutPerMtok: positiveNumber(env, "BOQ_PRICE_OUT"),

    // Application settings
    currency: required(env, "BOQ_CURRENCY"),
    BOQ_CORS_ORIGINS: required(env, "BOQ_CORS_ORIGINS"),
  });
}

export const SETTINGS = loadSettings();
