/**
 * Minimal JSON Schema -> Zod converter.
 *
 * The MCP SDK accepts Zod only, but the tool surface in `manifest.json` is
 * generated from the backend and arrives as JSON Schema. Converting at load
 * time keeps the manifest a pure data artifact, so re-syncing the tool surface
 * is a file replacement rather than a code change.
 *
 * Deliberately covers only the constructs the backend actually emits: string,
 * integer, number, boolean, array, object, enum, and nullable type unions.
 * Anything unrecognised degrades to z.any() rather than throwing, so a future
 * backend schema can never break server startup.
 */

import { z } from 'zod';

export interface JsonSchema {
  type?: string | string[];
  description?: string;
  enum?: unknown[];
  items?: JsonSchema;
  // A JSON import types absent keys as optional, so values may be undefined.
  properties?: Record<string, JsonSchema | undefined>;
  required?: string[];
}

/** Pull the meaningful type out of `"string"` or `["string", "null"]`. */
function baseType(schema: JsonSchema): { type?: string; nullable: boolean } {
  const raw = schema.type;
  if (Array.isArray(raw)) {
    const nullable = raw.includes('null');
    return { type: raw.find(entry => entry !== 'null'), nullable };
  }
  return { type: raw, nullable: false };
}

function convert(schema: JsonSchema): z.ZodTypeAny {
  const { type, nullable } = baseType(schema);
  let built: z.ZodTypeAny;

  const enumValues = schema.enum?.filter((v): v is string => typeof v === 'string');
  if (enumValues && enumValues.length > 0) {
    built =
      enumValues.length === 1
        ? z.literal(enumValues[0])
        : z.enum(enumValues as [string, ...string[]]);
  } else {
    switch (type) {
      case 'string':
        built = z.string();
        break;
      case 'integer':
        built = z.number().int();
        break;
      case 'number':
        built = z.number();
        break;
      case 'boolean':
        built = z.boolean();
        break;
      case 'array':
        built = z.array(schema.items ? convert(schema.items) : z.any());
        break;
      case 'object': {
        const props = schema.properties;
        if (props && Object.keys(props).length > 0) {
          const shape: Record<string, z.ZodTypeAny> = {};
          const required = new Set(schema.required ?? []);
          for (const [key, value] of Object.entries(props)) {
            if (!value) continue;
            const field = convert(value);
            shape[key] = required.has(key) ? field : field.optional();
          }
          // Backend serializers accept extra keys on nested config objects.
          built = z.object(shape).passthrough();
        } else {
          built = z.record(z.any());
        }
        break;
      }
      default:
        built = z.any();
    }
  }

  if (nullable) built = built.nullable();
  if (schema.description) built = built.describe(schema.description);
  return built;
}

/**
 * Convert a top-level object schema into the ZodRawShape that
 * `server.tool(name, description, shape, cb)` expects.
 */
export function toZodShape(schema: JsonSchema): Record<string, z.ZodTypeAny> {
  const shape: Record<string, z.ZodTypeAny> = {};
  const required = new Set(schema.required ?? []);
  for (const [key, value] of Object.entries(schema.properties ?? {})) {
    if (!value) continue;
    const field = convert(value);
    shape[key] = required.has(key) ? field : field.optional();
  }
  return shape;
}
