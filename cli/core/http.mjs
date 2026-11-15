// fetch with a timeout and an error that says what failed instead of "fetch failed".
import { APP } from './paths.mjs';

export const USER_AGENT = `${APP}/0.1`;

export async function httpRequest(url, { method = 'GET', headers, body, timeoutMs = 120_000 } = {}) {
  let response;
  try {
    response = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    const reason = error.name === 'TimeoutError'
      ? `no answer within ${timeoutMs / 1000} s`
      : error.cause?.code || error.cause?.message || error.message;
    const failure = new Error(`${method} ${url}: ${reason}`);
    failure.reason = reason;
    throw failure;
  }
  return { ok: response.ok, status: response.status, text: await response.text() };
}

export async function fetchRetry(url, attempts = 6) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(120_000), headers: { 'user-agent': USER_AGENT } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res;
    } catch (error) {
      lastError = error;
      await new Promise(resolve => setTimeout(resolve, 500 * (i + 1)));
    }
  }
  throw new Error(`download failed: ${url}: ${lastError.message}`);
}
