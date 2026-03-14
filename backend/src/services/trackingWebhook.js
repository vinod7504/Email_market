function getOpenWebhookUrl() {
  return String(process.env.EMAIL_OPEN_WEBHOOK_URL || process.env.OPEN_TRACKING_WEBHOOK_URL || '').trim();
}

function getOpenWebhookMethod() {
  const method = String(process.env.EMAIL_OPEN_WEBHOOK_METHOD || 'POST')
    .trim()
    .toUpperCase();

  if (method === 'AUTO') {
    return 'AUTO';
  }

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

function getWebhookRetryCount() {
  const parsed = Number(process.env.OPEN_WEBHOOK_RETRIES || 2);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 2;
  }

  return Math.min(Math.round(parsed), 5);
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

async function dispatchWebhook({ url, method, payload }) {
  const requestUrl = method === 'GET' ? buildGetUrl(url, payload) : url;
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), getWebhookTimeoutMs());
  const request = {
    method,
    headers: {
      'User-Agent': 'mailpilot-open-tracker/1.0'
    },
    signal: controller.signal
  };

  if (method === 'POST') {
    request.headers['Content-Type'] = 'application/json';
    request.body = JSON.stringify(payload);
  }

  try {
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
      status: response.status,
      responseText
    };
  } catch (error) {
    const timeout = error?.name === 'AbortError';
    return {
      ok: false,
      status: 0,
      timeout,
      error: timeout ? 'Webhook request timed out.' : error?.message || 'Webhook request failed.'
    };
  } finally {
    clearTimeout(timeoutHandle);
  }
}

function sleepMs(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function dispatchWebhookWithRetries({ url, method, payload }) {
  const retryCount = getWebhookRetryCount();
  let result = null;

  for (let attempt = 1; attempt <= retryCount + 1; attempt += 1) {
    result = await dispatchWebhook({ url, method, payload });
    if (result?.ok) {
      return {
        ...result,
        method,
        attempts: attempt
      };
    }

    if (attempt <= retryCount) {
      const backoffMs = Math.min(250 * 2 ** (attempt - 1), 2000);
      await sleepMs(backoffMs);
    }
  }

  return {
    ...(result || { ok: false, status: 0, error: 'Webhook request failed.' }),
    method,
    attempts: retryCount + 1
  };
}

function shouldFallbackToAlternateMethod(method, result) {
  if (!result || result.ok) {
    return false;
  }

  const status = Number(result.status || 0);
  if (!status) {
    return true;
  }

  if ([404, 405, 415, 422, 500, 501, 502, 503, 504].includes(status)) {
    return true;
  }

  const text = String(result.responseText || result.error || '').toLowerCase();
  if (method === 'POST') {
    return text.includes('did you mean to make a get request');
  }

  if (method === 'GET') {
    return text.includes('did you mean to make a post request') || text.includes('method not allowed');
  }

  return false;
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

  const preferredMethod = getOpenWebhookMethod();
  const primaryMethod = preferredMethod === 'AUTO' ? 'POST' : preferredMethod;
  const primaryResult = await dispatchWebhookWithRetries({
    url: parsedUrl.toString(),
    method: primaryMethod,
    payload
  });

  if (primaryResult.ok) {
    return primaryResult;
  }

  const fallbackMethod = primaryMethod === 'POST' ? 'GET' : 'POST';
  const shouldFallback =
    preferredMethod === 'AUTO' || shouldFallbackToAlternateMethod(primaryMethod, primaryResult);

  if (!shouldFallback) {
    return primaryResult;
  }

  const fallbackResult = await dispatchWebhookWithRetries({
    url: parsedUrl.toString(),
    method: fallbackMethod,
    payload
  });

  return {
    ...fallbackResult,
    attemptedMethod: primaryMethod,
    fallbackMethod,
    primaryError: primaryResult.error,
    primaryStatus: primaryResult.status
  };
}

module.exports = {
  getOpenWebhookUrl,
  getOpenWebhookMethod,
  notifyEmailOpened
};
