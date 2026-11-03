
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  OpenAIPdfReader,
  OpenAIResponsesClient,
} from "../openai/pdfReader.js";

import { OPENAI_DOCUMENT_SCHEMA } from "../openai/documentSchema.js";

const tempDirs = [];

function makeReader({ client, model = "test-openai-model" } = {}) {
  const cacheDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "boq-openai-test-"),
  );

  tempDirs.push(cacheDir);

  return new OpenAIPdfReader({
    apiKey: "test-key",
    baseUrl: "https://api.openai.com/v1",
    model,
    maxTokens: 16000,
    cacheDir,
    timeoutMs: 5000,
    maxRetries: 0,
    client,
  });
}

function successfulResponse(raw = {
  project_name: "Test project",
  views: [{ name: "Floor plan" }],
  document_warnings: [],
}) {
  return {
    status: "completed",
    output_text: JSON.stringify(raw),
    usage: {
      input_tokens: 1200,
      output_tokens: 450,
    },
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("OpenAI PDF reader", () => {
  it("sends the PDF and strict JSON schema to the Responses API client", async () => {
    const pdf = Buffer.from("%PDF-1.7 test drawing");
    let captured;

    const client = {
      async create(params) {
        captured = params;
        return successfulResponse();
      },
    };

    const reader = makeReader({ client });
    const result = await reader.read(pdf, "house_plan.pdf");

    assert.equal(captured.model, "test-openai-model");
    assert.equal(captured.max_output_tokens, 16000);
    assert.equal(captured.text.format.type, "json_schema");
    assert.equal(captured.text.format.strict, true);
    assert.deepEqual(
      captured.text.format.schema,
      OPENAI_DOCUMENT_SCHEMA,
    );

    const content = captured.input[0].content;
    const file = content.find((item) => item.type === "input_file");
    const text = content.find((item) => item.type === "input_text");

    assert.equal(file.filename, "house_plan.pdf");
    assert.ok(file.file_data.startsWith("data:application/pdf;base64,"));

    const encoded = file.file_data.split(",")[1];
    assert.deepEqual(Buffer.from(encoded, "base64"), pdf);

    assert.equal(text.text, "Drawing set: house_plan.pdf\nRead every page and call record_drawing_set with all drawings found.");

    assert.deepEqual(result.raw.views, [{ name: "Floor plan" }]);
    assert.deepEqual(result.usage, {
      input_tokens: 1200,
      output_tokens: 450,
    });
    assert.equal(result.cached, false);
  });

  it("returns cached data without making another API call", async () => {
    let calls = 0;

    const reader = makeReader({
      client: {
        async create() {
          calls++;
          return successfulResponse();
        },
      },
    });

    const pdf = Buffer.from("%PDF-1.7 cache test");

    const first = await reader.read(pdf);
    const second = await reader.read(pdf);

    assert.equal(calls, 1);
    assert.equal(first.cached, false);
    assert.equal(second.cached, true);
    assert.deepEqual(second.raw, first.raw);
    assert.equal(second.usage, null);
    assert.equal(reader.cache_hits, 1);
  });

  it("does not cache malformed JSON", async () => {
    let calls = 0;

    const reader = makeReader({
      client: {
        async create() {
          calls++;

          if (calls === 1) {
            return {
              status: "completed",
              output_text: "{invalid json",
              usage: {
                input_tokens: 100,
                output_tokens: 20,
              },
            };
          }

          return successfulResponse();
        },
      },
    });

    const pdf = Buffer.from("%PDF-1.7 malformed test");

    await assert.rejects(
      reader.read(pdf),
      /incomplete or malformed JSON/,
    );

    const result = await reader.read(pdf);

    assert.equal(calls, 2);
    assert.equal(result.cached, false);
    assert.ok(Array.isArray(result.raw.views));
  });

  it("rejects an incomplete response", async () => {
    const reader = makeReader({
      client: {
        async create() {
          return {
            status: "incomplete",
            incomplete_details: {
              reason: "max_output_tokens",
            },
            output_text: "",
            usage: {
              input_tokens: 100,
              output_tokens: 16000,
            },
          };
        },
      },
    });

    await assert.rejects(
      reader.read(Buffer.from("%PDF-1.7 truncated test")),
      /cut off.*BOQ_MAX_TOKENS/,
    );
  });

  it("rejects a response with no structured output", async () => {
    const reader = makeReader({
      client: {
        async create() {
          return {
            status: "completed",
            output: [],
            usage: null,
          };
        },
      },
    });

    await assert.rejects(
      reader.read(Buffer.from("%PDF-1.7 empty test")),
      /no structured result/,
    );
  });
});

describe("OpenAI Responses API client", () => {
  it("reports missing API keys without making a request", async () => {
    const client = new OpenAIResponsesClient({
      apiKey: "",
      maxRetries: 0,
    });

    await assert.rejects(
      client.create({ model: "test-model" }),
      /OPENAI_API_KEY is not configured/,
    );
  });
});
