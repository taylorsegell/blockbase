import {
  ContractValidationError,
  objectAt,
  requiredArray,
  requiredString,
  stringAt,
  versionedObject,
  CONTRACT_VERSION,
  type ContractVersion,
  type JsonObject,
} from './runtime.js';
import { parseComponentManifest, type ComponentManifest } from './component.js';

/**
 * `packages/contracts` has zero runtime dependencies and must stay usable outside Node (it is
 * imported by both the MCP server and, in a later milestone, a laptop CLI client that verifies
 * a received package before trusting it). `get_component_package` payloads carry cryptographic
 * hashes and base64-encoded bytes, so this module implements SHA-256 and standard base64
 * decoding itself rather than reaching for `node:crypto` / `Buffer`, which would require adding
 * a Node type dependency this package does not otherwise have. Both implementations are
 * self-contained, allocation-light, and covered by round-trip tests against Node's own
 * `crypto`/`Buffer` in `packages/contracts/test/remote-catalog.test.mjs`.
 */

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const SHA256_H0 = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

function rotr(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

/** FIPS 180-4 SHA-256 over raw bytes, returning lowercase hex (no "sha256:" prefix). */
function sha256Hex(bytes: Uint8Array): string {
  const h = SHA256_H0.slice();
  const bitLength = bytes.length * 8;
  const bitLengthHi = Math.floor(bitLength / 4294967296) >>> 0;
  const bitLengthLo = (bitLength % 4294967296) >>> 0;
  const withMarker = bytes.length + 1;
  const zeroPadding = (((56 - (withMarker % 64)) % 64) + 64) % 64;
  const total = withMarker + zeroPadding + 8;
  const padded = new Uint8Array(total);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(total - 8, bitLengthHi, false);
  view.setUint32(total - 4, bitLengthLo, false);

  const schedule = new Uint32Array(64);
  for (let offset = 0; offset < total; offset += 64) {
    for (let i = 0; i < 16; i += 1) schedule[i] = view.getUint32(offset + i * 4, false);
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr(schedule[i - 15], 7) ^ rotr(schedule[i - 15], 18) ^ (schedule[i - 15] >>> 3);
      const s1 = rotr(schedule[i - 2], 17) ^ rotr(schedule[i - 2], 19) ^ (schedule[i - 2] >>> 10);
      schedule[i] = (schedule[i - 16] + s0 + schedule[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (hh + s1 + ch + SHA256_K[i] + schedule[i]) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) >>> 0;
      hh = g; g = f; f = e; e = (d + temp1) >>> 0;
      d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0; h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
  }
  let hex = '';
  for (const word of h) hex += word.toString(16).padStart(8, '0');
  return hex;
}

/** Encodes a JS string to UTF-8 bytes, matching `Buffer.from(value, 'utf8')` / `TextEncoder`. */
function utf8Encode(value: string): Uint8Array {
  const bytes: number[] = [];
  for (let i = 0; i < value.length; i += 1) {
    const unit = value.charCodeAt(i);
    let codePoint = unit;
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        codePoint = (unit - 0xd800) * 0x400 + (next - 0xdc00) + 0x10000;
        i += 1;
      } else {
        codePoint = 0xfffd;
      }
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      codePoint = 0xfffd;
    }
    if (codePoint < 0x80) {
      bytes.push(codePoint);
    } else if (codePoint < 0x800) {
      bytes.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f));
    } else if (codePoint < 0x10000) {
      bytes.push(0xe0 | (codePoint >> 12), 0x80 | ((codePoint >> 6) & 0x3f), 0x80 | (codePoint & 0x3f));
    } else {
      bytes.push(0xf0 | (codePoint >> 18), 0x80 | ((codePoint >> 12) & 0x3f), 0x80 | ((codePoint >> 6) & 0x3f), 0x80 | (codePoint & 0x3f));
    }
  }
  return Uint8Array.from(bytes);
}

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const BASE64_LOOKUP = (() => {
  const table = new Int16Array(128).fill(-1);
  for (let i = 0; i < BASE64_ALPHABET.length; i += 1) table[BASE64_ALPHABET.charCodeAt(i)] = i;
  return table;
})();

/**
 * Strictly decodes standard (RFC 4648, `+`/`/`, `=`-padded) base64. Returns `undefined` for any
 * malformed input (wrong length, invalid characters, misplaced padding) instead of the lenient
 * best-effort decoding `atob`/`Buffer` perform, since a malformed payload here must be rejected,
 * not silently truncated or reinterpreted.
 */
function decodeBase64Strict(value: string): Uint8Array | undefined {
  if (value.length === 0) return new Uint8Array(0);
  if (value.length % 4 !== 0) return undefined;
  const paddingCount = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const dataLength = value.length - paddingCount;
  for (let i = 0; i < value.length; i += 1) {
    if (i >= dataLength) {
      if (value[i] !== '=') return undefined;
      continue;
    }
    const code = value.charCodeAt(i);
    if (code > 127 || BASE64_LOOKUP[code] === -1) return undefined;
  }
  const outLength = (value.length / 4) * 3 - paddingCount;
  const out = new Uint8Array(outLength);
  let outIndex = 0;
  for (let i = 0; i < value.length; i += 4) {
    const c0 = BASE64_LOOKUP[value.charCodeAt(i)];
    const c1 = BASE64_LOOKUP[value.charCodeAt(i + 1)];
    const rawC2 = value[i + 2] === '=' ? 0 : BASE64_LOOKUP[value.charCodeAt(i + 2)];
    const rawC3 = value[i + 3] === '=' ? 0 : BASE64_LOOKUP[value.charCodeAt(i + 3)];
    const c2 = rawC2 < 0 ? 0 : rawC2;
    const c3 = rawC3 < 0 ? 0 : rawC3;
    const triple = (c0 << 18) | (c1 << 12) | (c2 << 6) | c3;
    if (outIndex < outLength) { out[outIndex] = (triple >> 16) & 0xff; outIndex += 1; }
    if (outIndex < outLength) { out[outIndex] = (triple >> 8) & 0xff; outIndex += 1; }
    if (outIndex < outLength) { out[outIndex] = triple & 0xff; outIndex += 1; }
  }
  return out;
}

/**
 * Bounds for one `RemoteComponentPackage` payload. A single UI component's source files and any
 * small accompanying assets (icons, fixtures) comfortably fit within these; anything larger is
 * rejected outright as malformed or hostile rather than partially processed.
 */
export const REMOTE_PACKAGE_MAX_ENTRIES = 500;
/** 8 MiB, matching the MCP HTTP transport's own request-body cap (`MAX_HTTP_BODY_BYTES`). */
export const REMOTE_PACKAGE_MAX_DECODED_BYTES = 8 * 1024 * 1024;

export type RemotePackageFile = {
  path: string;
  content: string;
  contentHash: string;
};

export type RemotePackageAsset = {
  path: string;
  contentBase64: string;
  contentHash: string;
  mediaType: string;
};

export type RemoteComponentPackage = {
  schemaVersion: ContractVersion;
  componentId: string;
  revisionId: string;
  manifest: ComponentManifest;
  files: RemotePackageFile[];
  assets: RemotePackageAsset[];
};

const CONTENT_HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;

function issue(path: string, message: string): ContractValidationError {
  return new ContractValidationError('contract', [{ path, message }]);
}

/** Rejects absolute paths, `..`/`.`/empty segments, backslashes, and null bytes. */
function assertRelativePackagePath(value: unknown, path: string): string {
  const raw = stringAt(value, path);
  if (raw.includes('\\') || raw.includes('\0')) {
    throw issue(path, 'must use forward slashes only and must not contain null bytes');
  }
  if (raw.startsWith('/') || /^[A-Za-z]:[/\\]/.test(raw)) {
    throw issue(path, 'must be a relative path, not absolute');
  }
  const segments = raw.split('/');
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    throw issue(path, 'must not contain empty, "." or ".." path segments');
  }
  return raw;
}

function assertDeclaredHash(value: unknown, path: string): string {
  const raw = stringAt(value, path);
  if (!CONTENT_HASH_PATTERN.test(raw)) {
    throw issue(path, 'must be a sha256 hash formatted as "sha256:<64 lowercase hex characters>"');
  }
  return raw;
}

function verifyContentHash(bytes: Uint8Array, declared: string, path: string): void {
  const actual = `sha256:${sha256Hex(bytes)}`;
  if (actual !== declared) {
    throw issue(path, `content hash mismatch: declared ${declared}, computed ${actual}`);
  }
}

function trackBudget(budget: { entries: number; bytes: number }, addedBytes: number): void {
  budget.entries += 1;
  budget.bytes += addedBytes;
  if (budget.entries > REMOTE_PACKAGE_MAX_ENTRIES) {
    throw issue('$', `must contain at most ${REMOTE_PACKAGE_MAX_ENTRIES} combined files and assets`);
  }
  if (budget.bytes > REMOTE_PACKAGE_MAX_DECODED_BYTES) {
    throw issue('$', `combined decoded file and asset content must not exceed ${REMOTE_PACKAGE_MAX_DECODED_BYTES} bytes`);
  }
}

function parseFileEntry(value: unknown, index: number, seenPaths: Set<string>, budget: { entries: number; bytes: number }): RemotePackageFile {
  const object = objectAt(value, `$.files[${index}]`);
  const path = assertRelativePackagePath(object.path, `$.files[${index}].path`);
  if (seenPaths.has(path)) throw issue(`$.files[${index}].path`, `duplicate path "${path}" (paths must be unique across files and assets combined)`);
  seenPaths.add(path);
  if (typeof object.content !== 'string') throw issue(`$.files[${index}].content`, 'must be a string');
  const contentHash = assertDeclaredHash(object.contentHash, `$.files[${index}].contentHash`);
  const bytes = utf8Encode(object.content);
  trackBudget(budget, bytes.length);
  verifyContentHash(bytes, contentHash, `$.files[${index}].contentHash`);
  return { path, content: object.content, contentHash };
}

function parseAssetEntry(value: unknown, index: number, seenPaths: Set<string>, budget: { entries: number; bytes: number }): RemotePackageAsset {
  const object = objectAt(value, `$.assets[${index}]`);
  const path = assertRelativePackagePath(object.path, `$.assets[${index}].path`);
  if (seenPaths.has(path)) throw issue(`$.assets[${index}].path`, `duplicate path "${path}" (paths must be unique across files and assets combined)`);
  seenPaths.add(path);
  const mediaType = stringAt(object.mediaType, `$.assets[${index}].mediaType`);
  const contentHash = assertDeclaredHash(object.contentHash, `$.assets[${index}].contentHash`);
  if (typeof object.contentBase64 !== 'string') throw issue(`$.assets[${index}].contentBase64`, 'must be a string');
  const bytes = decodeBase64Strict(object.contentBase64);
  if (!bytes) throw issue(`$.assets[${index}].contentBase64`, 'must be valid standard base64 (RFC 4648) with correct padding');
  trackBudget(budget, bytes.length);
  verifyContentHash(bytes, contentHash, `$.assets[${index}].contentHash`);
  return { path, contentBase64: object.contentBase64, contentHash, mediaType };
}

function buildRemoteComponentPackage(object: JsonObject): RemoteComponentPackage {
  const componentId = requiredString(object, 'componentId');
  const revisionId = requiredString(object, 'revisionId');
  const manifest = parseComponentManifest(object.manifest);
  const rawFiles = requiredArray(object, 'files');
  const rawAssets = requiredArray(object, 'assets');
  if (rawFiles.length + rawAssets.length > REMOTE_PACKAGE_MAX_ENTRIES) {
    throw issue('$', `must contain at most ${REMOTE_PACKAGE_MAX_ENTRIES} combined files and assets`);
  }
  const seenPaths = new Set<string>();
  const budget = { entries: 0, bytes: 0 };
  const files = rawFiles.map((entry, index) => parseFileEntry(entry, index, seenPaths, budget));
  const assets = rawAssets.map((entry, index) => parseAssetEntry(entry, index, seenPaths, budget));
  return { schemaVersion: CONTRACT_VERSION, componentId, revisionId, manifest, files, assets };
}

/**
 * Parses and fully verifies an immutable `RemoteComponentPackage` v1 payload: a versioned,
 * self-contained snapshot of one component revision's manifest plus its relative source files
 * (UTF-8 `content` + SHA-256 `contentHash`) and assets (base64 `contentBase64` + `mediaType` +
 * SHA-256 `contentHash`). Rejects absolute paths, path traversal, duplicate paths (within
 * files, within assets, and across the two combined), invalid base64, any hash that does not
 * match its recomputed content, unbounded entry counts, and oversized decoded payloads. On
 * success, returns a freshly constructed object containing only the known, validated fields —
 * it never echoes unrecognized input properties.
 */
export function parseRemoteComponentPackage(input: unknown): RemoteComponentPackage {
  const object = versionedObject(input, 'RemoteComponentPackage');
  try {
    return buildRemoteComponentPackage(object);
  } catch (error) {
    if (error instanceof ContractValidationError) throw new ContractValidationError('RemoteComponentPackage', error.issues);
    throw error;
  }
}
