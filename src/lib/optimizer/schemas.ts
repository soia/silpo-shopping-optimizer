/**
 * Structured-output schemas.
 *
 * `output_config.format` constrains the reply to these, so there is no markdown
 * fence to strip and no half-JSON to repair. The constraints the API accepts are
 * narrower than JSON Schema's: every object needs `additionalProperties: false`
 * and a full `required` list, and numeric bounds are **not** supported — which
 * is why confidence is clamped in code after parsing rather than declared 0…1
 * here.
 */

export const SELECT_SCHEMA = {
  type: "object",
  properties: {
    chosen: { type: ["integer", "null"] },
    accept: { type: "boolean" },
    confidence: { type: "number" },
    reason: { type: "string" },
    verifySize: { type: "boolean" },
    alternates: {
      type: "array",
      items: {
        type: "object",
        properties: {
          index: { type: "integer" },
          reason: { type: "string" },
          confidence: { type: "number" },
        },
        required: ["index", "reason", "confidence"],
        additionalProperties: false,
      },
    },
  },
  required: ["chosen", "accept", "confidence", "reason", "verifySize", "alternates"],
  additionalProperties: false,
} as const;

export const WISH_SCHEMA = {
  type: 'object',
  properties: { wish: { type: 'string' } },
  required: ['wish'],
  additionalProperties: false,
} as const;
