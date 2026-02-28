function buildFailureMessage(status, url, responseText, fallbackMessage) {
  const normalizedText = String(responseText || '').toLowerCase();
  const proxyDown =
    normalizedText.includes('econnrefused') ||
    normalizedText.includes('proxy error') ||
    normalizedText.includes('socket hang up') ||
    normalizedText.includes('invalid server response');

  if (status >= 500 && proxyDown) {
    return `Backend API is unreachable. Start backend on http://localhost:3000 and ensure MongoDB is running. Failed endpoint: ${url}`;
  }

  if (fallbackMessage) {
    return fallbackMessage;
  }

  return `Request failed (${status})`;
}

export async function fetchJson(url, options = {}) {
  let response;

  try {
    response = await fetch(url, options);
  } catch (error) {
    if (error && error.name === 'AbortError') {
      throw error;
    }

    throw new Error(
      `Cannot connect to backend API. Start backend on http://localhost:3000 and ensure MongoDB is running. Failed endpoint: ${url}`
    );
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
      buildFailureMessage(response.status, url, textPayload || payload?.error, payload?.error || textPayload || '')
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
