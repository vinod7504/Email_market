const DEFAULT_API_BASE_URL = 'https://email-market-rkeb.onrender.com';

function normalizeBaseUrl(value) {
  return String(value || '')
    .trim()
    .replace(/\/+$/, '');
}

const API_BASE_URL = normalizeBaseUrl(import.meta.env.VITE_API_BASE_URL || DEFAULT_API_BASE_URL);

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

export async function fetchJson(url, options = {}) {
  const requestUrl = resolveApiUrl(url);
  let response;

  try {
    response = await fetch(requestUrl, options);
  } catch (error) {
    if (error && error.name === 'AbortError') {
      throw error;
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
