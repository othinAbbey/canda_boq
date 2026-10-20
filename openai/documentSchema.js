
import { DOCUMENT_SCHEMA } from "../claude/documentSchema.js";

/**
 * Convert the shared document schema to OpenAI strict JSON Schema.
 *
 * Every property becomes required. Fields that were optional become nullable,
 * allowing the existing parser to receive null instead of missing values.
 * The original Claude schema is not modified.
 */
function makeStrict(schema) {
  if (Array.isArray(schema)) {
    return schema.map(makeStrict);
  }

  if (!schema || typeof schema !== "object") {
    return schema;
  }

  const result = {};

  for (const [key, value] of Object.entries(schema)) {
    if (key === "required" || key === "additionalProperties") {
      continue;
    }

    result[key] = makeStrict(value);
  }

  if (schema.type === "object" && schema.properties) {
    const properties = { ...result.properties };

    for (const [key, original] of Object.entries(schema.properties)) {
      if (!schema.required?.includes(key)) {
        const property = properties[key];

        if (property && property.type) {
          property.type = Array.isArray(property.type)
            ? [...new Set([...property.type, "null"])]
            : [property.type, "null"];
        } else if (property && !property.anyOf) {
          properties[key] = {
            anyOf: [property, { type: "null" }],
          };
        }
      }
    }

    result.properties = properties;
    result.required = Object.keys(properties);
    result.additionalProperties = false;
  }

  return result;
}

export const OPENAI_DOCUMENT_SCHEMA = makeStrict(
  structuredClone(DOCUMENT_SCHEMA)
);
