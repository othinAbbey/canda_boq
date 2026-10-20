import { ClaudePdfReader } from "../claude/pdfReader.js";
import { OpenAIPdfReader } from "../openai/pdfReader.js";
import { GeminiPdfReader } from "../gemini/pdfReader.js";

/**
 * Every provider listed here receives the ORIGINAL PDF bytes (no local text
 * extraction or image conversion). To add a provider: write an adapter with
 *   read(pdfBuffer, filename, useCache) -> { raw, usage, cached }
 * and add one line to this table (and to SUPPORTED in config.js).
 */
const READERS = {
  anthropic: ClaudePdfReader,
  openai: OpenAIPdfReader,
  gemini: GeminiPdfReader,
};

export const SUPPORTED_PROVIDERS = Object.keys(READERS);

export function createPdfReader(settings) {
  if (!settings.apiKey) {
    throw new Error(
      `AI_API_KEY is not configured on the backend (provider: ${settings.aiProvider}; ` +
      "set that provider's own key variable or AI_API_KEY)");
  }

  const Reader = READERS[settings.aiProvider];
  if (!Reader) {
    throw new Error(
      `Unsupported AI provider: "${settings.aiProvider}". Supported providers: ${SUPPORTED_PROVIDERS.join(", ")}.`);
  }

  return new Reader({
    apiKey: settings.apiKey,
    baseUrl: settings.baseUrl,
    model: settings.model,
    maxTokens: settings.maxTokens,
    cacheDir: settings.cacheDir,
    timeoutMs: settings.timeoutMs,
    maxRetries: settings.maxRetries,
  });
}
