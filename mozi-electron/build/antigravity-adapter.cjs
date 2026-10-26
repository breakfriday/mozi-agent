const path = require('node:path');

// pi-antigravity@0.11.0 only. Fail the build on upstream drift rather than silently
// losing cancellation or enabling CLI account persistence after a dependency bump.
function adaptOAuthSource(source) {
  function replace(before, after) {
    if (!source.includes(before)) throw new Error('pi-antigravity OAuth adapter needs review: ' + before);
    source = source.replace(before, after);
  }
  replace('const { waitForCode, cleanup } = await startCallbackServer(state);',
    'callbacks.signal?.throwIfAborted();\n  const { waitForCode, cleanup } = await startCallbackServer(state);\n  callbacks.signal?.addEventListener("abort", cleanup, { once: true });\n  if (callbacks.signal?.aborted) cleanup();');
  replace('  } finally {\n    cleanup();\n  }',
    '  } finally {\n    callbacks.signal?.removeEventListener("abort", cleanup);\n    cleanup();\n  }');
  replace('const tokenResponse = await oauthFetch(TOKEN_URL, {',
    'const tokenResponse = await oauthFetch(TOKEN_URL, {\n      signal: AbortSignal.any([...(callbacks.signal ? [callbacks.signal] : []), AbortSignal.timeout(30_000)]),');
  replace('async function getUserEmail(token: string)', 'async function getUserEmail(token: string, signal?: AbortSignal)');
  replace('headers: { Authorization: `Bearer ${token}` },',
    'signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(10_000)]),\n      headers: { Authorization: `Bearer ${token}` },');
  replace('getUserEmail(tokenData.access_token),', 'getUserEmail(tokenData.access_token, callbacks.signal),');
  replace('export async function refreshAntigravityToken(\n  credentials: OAuthCredentials,',
    'export async function refreshAntigravityToken(\n  credentials: OAuthCredentials,\n  signal: AbortSignal,');
  replace('const response = await oauthFetch(TOKEN_URL, {',
    'const response = await oauthFetch(TOKEN_URL, {\n    signal: AbortSignal.any([signal, AbortSignal.timeout(8_000)]),');
  return source;
}
function singleAccountPath(source, importer = '') {
  if (importer.replaceAll('\\', '/').includes('/pi-antigravity/src/') && /(?:^|\/)accounts\.js$/.test(source))
    return path.resolve(__dirname, '../src/agent/runtime/pi/providers/antigravity/single-account.ts');
}
module.exports = { adaptOAuthSource, singleAccountPath };
