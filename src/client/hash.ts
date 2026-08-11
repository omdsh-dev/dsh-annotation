/**
 * Deterministic, dependency-free content hash for batch ids. Not a security
 * primitive — it only needs to flip on ANY content change so a reused
 * batchId can never collide with changed data.
 */

/** FNV-1a 64-bit over UTF-16 code units, hex-encoded. */
export function contentHash(input: string): string {
  let hash = 0xcbf29ce484222325n
  const prime = 0x100000001b3n
  for (let i = 0; i < input.length; i += 1) {
    hash ^= BigInt(input.charCodeAt(i))
    hash = (hash * prime) & 0xffffffffffffffffn
  }
  return hash.toString(16).padStart(16, '0')
}
