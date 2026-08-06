/**
 * Tool descriptions taken from the generated manifest.
 *
 * A hand-written tool whose backend twin exists should show the backend's text,
 * not a copy of it. Copies drift: the backend edits its wording, the manifest is
 * regenerated, and the pasted string here silently keeps the old claim. Reading
 * it back from the manifest makes regeneration the only step needed.
 *
 * The manifest is sanitized at generation time, so nothing internal reaches a
 * description this returns.
 */

import manifest from './manifest.json' with { type: 'json' };

const BY_NAME = new Map<string, string>(
  (manifest.tools as { name: string; description: string }[]).map(t => [t.name, t.description]),
);

/** The backend's description for a tool, or undefined if it has no twin. */
export function backendDescription(tool: string): string | undefined {
  return BY_NAME.get(tool);
}
