const KAI_ORIGIN = 'https://kai.com';
const KAI_PATHS = [/^\/\.well-known\/kai-agent-manifest\.json$/u, /^\/offers\/[A-Za-z0-9._-]+$/u, /^\/proof\/[A-Za-z0-9._-]+$/u];

/**
 * Canonicalize a source URL before it can enter an Offer or Receipt.
 * Model-provided URLs are never trusted as-is.
 */
export function canonicalizeKaiSourceUrl(raw) {
  let url;
  try { url = new URL(String(raw)); } catch { throw new Error('SOURCE_URL_INVALID'); }
  if (url.origin !== KAI_ORIGIN || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('SOURCE_URL_UNTRUSTED_ORIGIN');
  }
  if (!KAI_PATHS.some((pattern) => pattern.test(url.pathname))) throw new Error('SOURCE_URL_PATH_NOT_ALLOWED');
  return url.href;
}

export const KAI_SOURCE_ORIGIN = KAI_ORIGIN;
