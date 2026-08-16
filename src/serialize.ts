/**
 * Tag-safe JSON for text that is framed inside pseudo-XML tags.
 *
 * @module dsh-reference-anything/serialize
 */

/**
 * Serialize a value as JSON in which no `<` survives literally.
 *
 * Referenced material is untrusted text placed inside a
 * `<referenced-conversations>` frame. Without this, a conversation whose
 * content spells that frame's closing tag would appear to end the data region,
 * and everything after it would read to the model as the harness speaking
 * rather than as quoted material.
 *
 * Each one becomes its six-character JSON unicode escape instead. That escape
 * is valid only inside a JSON string, and a literal `<` only ever occurs
 * inside string literals in `JSON.stringify` output, so the substitution is
 * lossless: parsing the result yields the original value exactly.
 * @param value - any JSON-serializable value.
 * @returns indented JSON carrying no literal `<`.
 */
export function stringifyTagSafeJson(value: unknown): string {
  return JSON.stringify(value, null, 2).replace(/</gu, '\\u003c')
}
