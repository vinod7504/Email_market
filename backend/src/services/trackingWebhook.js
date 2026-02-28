function getOpenWebhookUrl() {
  return String(process.env.EMAIL_OPEN_WEBHOOK_URL || process.env.OPEN_TRACKING_WEBHOOK_URL || '').trim();
}

function getOpenWebhookMethod() {
  const method = String(process.env.EMAIL_OPEN_WEBHOOK_METHOD || 'POST')
    .trim()
    .toUpperCase();

  if (method === 'GET') {
    return 'GET';
  }

  return 'POST';
}

function getWebhookTimeoutMs() {
  const parsed = Number(process.env.OPEN_WEBHOOK_TIMEOUT_MS || 5000);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 5000;
  }

  return Math.min(parsed, 30000);
}

function buildGetUrl(url, payload) {
  const parsed = new URL(url);
  for (const [key, value] of Object.entries(payload || {})) {
    if (value === undefined || value === null) {
      continue;
    }

    parsed.searchParams.set(key, String(value));
  }

  return parsed.toString();
}

function buildWebhookError(status, responseText) {
  return `Webhook request failed (${status})${responseText ? `: ${responseText.slice(0, 300)}` : ''}`;
}

async function dispatchWebhook({ url, method, payload, signal }) {
  const requestUrl = method === 'GET' ? buildGetUrl(url, payload) : url;
  const request = {
    method,
    headers: {
      'User-Agent': 'mailpilot-open-tracker/1.0'
    },
    signal
  };

  if (method === 'POST') {
    request.headers['Content-Type'] = 'application/json';
    request.body = JSON.stringify(payload);
  }

  const response = await fetch(requestUrl, request);
  const responseText = await response.text().catch(() => '');

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      error: buildWebhookError(response.status, responseText),
      responseText
    };
  }

  return {
    ok: true,
    status: response.status
  };
}

function shouldFallbackToGet(method, result) {
  if (method !== 'POST' || !result || result.ok) {
    return false;
  }

  const text = String(result.responseText || '').toLowerCase();
  return text.includes('did you mean to make a get request');
}

async function notifyEmailOpened(payload) {
  const url = getOpenWebhookUrl();
  if (!url) {
    return { skipped: true, reason: 'webhook_url_not_configured' };
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch (_error) {
    return { skipped: true, reason: 'invalid_webhook_url' };
  }

  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    return { skipped: true, reason: 'unsupported_webhook_protocol' };
  }

  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), getWebhookTimeoutMs());

  try {
    const preferredMethod = getOpenWebhookMethod();
    let result = await dispatchWebhook({
      url: parsedUrl.toString(),
      method: preferredMethod,
      payload,
      signal: controller.signal
    });

    if (shouldFallbackToGet(preferredMethod, result)) {
      const fallback = await dispatchWebhook({
        url: parsedUrl.toString(),
        method: 'GET',
        payload,
        signal: controller.signal
      });

      result = {
        ...fallback,
        attemptedMethod: preferredMethod,
        fallbackMethod: 'GET'
      };
    }

    return result;
  } catch (error) {
    return {
      ok: false,
      error: error?.message || 'Webhook request failed.'
    };
  } finally {
    clearTimeout(timeoutHandle);
  }
}

module.exports = {
  getOpenWebhookUrl,
  getOpenWebhookMethod,
  notifyEmailOpened
};
