export const PREVIEW_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "navigate-to 'none'",
].join('; ');

export const PREVIEW_IFRAME_SANDBOX = 'allow-scripts';

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

/** Attributes intentionally omit allow-same-origin: the frame must not share the host origin. */
export function sandboxIframe(src: string): string {
  return `<iframe title="Component preview" sandbox="${PREVIEW_IFRAME_SANDBOX}" referrerpolicy="no-referrer" src="${escapeHtml(src)}"></iframe>`;
}

export function previewDocument(frameSrc: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${escapeHtml(PREVIEW_CSP)}"><meta name="referrer" content="no-referrer"></head><body>${sandboxIframe(frameSrc)}</body></html>`;
}

export function previewContentHeaders(): Record<string, string> {
  return {
    'Content-Security-Policy': PREVIEW_CSP,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cache-Control': 'no-store',
  };
}
