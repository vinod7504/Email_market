import { clearSession, getSessionToken } from './session';
const DEFAULT_API_BASE_URL = 'https://email-market-rkeb.onrender.com';

function normalizeBaseUrl(value) {
  return String(value || '')
    .trim()
    .replace(/\/+$/, '');
}

const API_BASE_URL = normalizeBaseUrl(import.meta.env.VITE_API_BASE_URL || DEFAULT_API_BASE_URL);
const DEFAULT_API_TIMEOUT_MS = Number(import.meta.env.VITE_API_TIMEOUT_MS || 20000);
const DEFAULT_GET_RETRY_COUNT = Number(import.meta.env.VITE_API_GET_RETRIES || 2);

function formatBackendHint() {
  return API_BASE_URL || 'http://localhost:3000';
}

export function resolveApiUrl(url) {
  const rawUrl = String(url || '').trim();
  if (!rawUrl) {
    return API_BASE_URL;
  }

  if (/^https?:\/\//i.test(rawUrl)) {
    return rawUrl;
  }

  if (!rawUrl.startsWith('/')) {
    return rawUrl;
  }

  if (!API_BASE_URL) {
    return rawUrl;
  }

  return `${API_BASE_URL}${rawUrl}`;
}

export function withAuthHeaders(headers = {}) {
  const nextHeaders = new Headers(headers);
  const token = getSessionToken();
  if (token && !nextHeaders.has('Authorization')) {
    nextHeaders.set('Authorization', `Bearer ${token}`);
  }

  return nextHeaders;
}

function buildFailureMessage(status, url, responseText, fallbackMessage) {
  const normalizedText = String(responseText || '').toLowerCase();
  const proxyDown =
    normalizedText.includes('econnrefused') ||
    normalizedText.includes('proxy error') ||
    normalizedText.includes('socket hang up') ||
    normalizedText.includes('invalid server response');

  if (status >= 500 && proxyDown) {
    return `Backend API is unreachable at ${formatBackendHint()}. Ensure backend and MongoDB are running. Failed endpoint: ${url}`;
  }

  if (fallbackMessage) {
    return fallbackMessage;
  }

  return `Request failed (${status})`;
}

function normalizeTimeoutMs() {
  if (!Number.isFinite(DEFAULT_API_TIMEOUT_MS) || DEFAULT_API_TIMEOUT_MS <= 0) {
    return 20000;
  }

  return Math.min(Math.round(DEFAULT_API_TIMEOUT_MS), 120000);
}

function normalizeRetryCount() {
  if (!Number.isFinite(DEFAULT_GET_RETRY_COUNT) || DEFAULT_GET_RETRY_COUNT < 0) {
    return 2;
  }

  return Math.min(Math.round(DEFAULT_GET_RETRY_COUNT), 5);
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function fetchJson(url, options = {}) {
  const requestUrl = resolveApiUrl(url);
  let response;
  const requestHeaders = withAuthHeaders(options.headers || {});
  const requestOptions = {
    ...options,
    headers: requestHeaders
  };
  const requestMethod = String(requestOptions.method || 'GET').toUpperCase();
  const shouldRetry = requestMethod === 'GET' || requestMethod === 'HEAD';
  const maxRetries = shouldRetry ? normalizeRetryCount() : 0;
  const timeoutMs = normalizeTimeoutMs();
  let lastErrorWasTimeout = false;
  let lastNetworkError = null;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    let timeoutHandle = null;
    let attemptTimedOut = false;
    const attemptOptions = {
      ...requestOptions,
      headers: withAuthHeaders(options.headers || {})
    };
    const timeoutController = !attemptOptions.signal ? new AbortController() : null;
    if (timeoutController) {
      attemptOptions.signal = timeoutController.signal;
      timeoutHandle = setTimeout(() => {
        attemptTimedOut = true;
        timeoutController.abort();
      }, timeoutMs);
    }

    try {
      response = await fetch(requestUrl, attemptOptions);
      lastErrorWasTimeout = false;
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      break;
    } catch (error) {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }

      const abortedByCaller = Boolean(options.signal?.aborted);
      if (abortedByCaller) {
        throw error;
      }

      const isAbort = error && error.name === 'AbortError';
      if (isAbort && !attemptTimedOut) {
        throw error;
      }

      lastErrorWasTimeout = attemptTimedOut;
      lastNetworkError = error;
      const hasMoreAttempts = attempt < maxRetries;
      if (!hasMoreAttempts) {
        break;
      }

      const backoffMs = Math.min(250 * 2 ** attempt, 1500);
      await delay(backoffMs);
    }
  }

  if (!response) {
    if (lastErrorWasTimeout) {
      throw new Error(`Request timed out after ${timeoutMs}ms. Failed endpoint: ${requestUrl}`);
    }

    if (lastNetworkError && lastNetworkError.name === 'AbortError') {
      throw lastNetworkError;
    }

    throw new Error(`Cannot connect to backend API at ${formatBackendHint()}. Failed endpoint: ${requestUrl}`);
  }

  const contentType = response.headers.get('content-type') || '';
  let payload = null;
  let textPayload = '';

  if (contentType.includes('application/json')) {
    payload = await response.json().catch(() => null);
  } else {
    textPayload = await response.text().catch(() => '');
  }

  if (!response.ok) {
    if (response.status === 401) {
      clearSession();
      if (typeof window !== 'undefined' && window.location.pathname !== '/login') {
        window.location.replace('/login');
      }
      const unauthorizedError = new Error(payload?.error || textPayload || 'Login required.');
      unauthorizedError.code = 'UNAUTHORIZED';
      throw unauthorizedError;
    }

    throw new Error(
      buildFailureMessage(response.status, requestUrl, textPayload || payload?.error, payload?.error || textPayload || '')
    );
  }

  if (payload !== null) {
    return payload;
  }

  return {};
}

export function formatDateTime(value) {
  if (!value) {
    return '-';
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '-';
  }

  return date.toLocaleString();
}
