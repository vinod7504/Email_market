const crypto = require('crypto');

const PKCE_STATE_TTL_MS = 10 * 60 * 1000;
const pkceStateStore = new Map();

const MICROSOFT_SCOPES = [
  'openid',
  'profile',
  'email',
  'offline_access',
  'https://graph.microsoft.com/User.Read',
  'https://graph.microsoft.com/Mail.Send'
];

function getMicrosoftConfig() {
  return {
    clientId: process.env.MICROSOFT_CLIENT_ID || '',
    clientSecret: process.env.MICROSOFT_CLIENT_SECRET || '',
    tenantId: process.env.MICROSOFT_TENANT_ID || 'common',
    redirectUri: process.env.MICROSOFT_REDIRECT_URI || ''
  };
}

function hasMicrosoftConfig() {
  const cfg = getMicrosoftConfig();
  return Boolean(cfg.clientId && cfg.redirectUri);
}

function getMicrosoftBaseAuthUrl() {
  const cfg = getMicrosoftConfig();
  if (!cfg.clientId || !cfg.redirectUri) {
    throw new Error(
      'Microsoft OAuth config is missing. Set MICROSOFT_CLIENT_ID and MICROSOFT_REDIRECT_URI.'
    );
  }

  return `https://login.microsoftonline.com/${encodeURIComponent(cfg.tenantId)}/oauth2/v2.0`;
}

function createOAuthState() {
  return crypto.randomBytes(12).toString('hex');
}

function toBase64Url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function createCodeVerifier() {
  return toBase64Url(crypto.randomBytes(48));
}

function createCodeChallenge(codeVerifier) {
  const digest = crypto.createHash('sha256').update(String(codeVerifier || ''), 'utf8').digest();
  return toBase64Url(digest);
}

function pruneExpiredPkceStates() {
  const now = Date.now();
  for (const [state, entry] of pkceStateStore.entries()) {
    if (!entry || Number(entry.expiresAt || 0) <= now) {
      pkceStateStore.delete(state);
    }
  }
}

function savePkceState(state, codeVerifier) {
  pruneExpiredPkceStates();
  pkceStateStore.set(state, {
    codeVerifier,
    expiresAt: Date.now() + PKCE_STATE_TTL_MS
  });
}

function consumePkceState(state) {
  pruneExpiredPkceStates();
  const key = String(state || '').trim();
  if (!key) {
    return null;
  }

  const entry = pkceStateStore.get(key);
  pkceStateStore.delete(key);
  if (!entry) {
    return null;
  }

  if (Number(entry.expiresAt || 0) <= Date.now()) {
    return null;
  }

  return String(entry.codeVerifier || '').trim() || null;
}

function getMicrosoftAuthUrl() {
  const cfg = getMicrosoftConfig();
  const base = getMicrosoftBaseAuthUrl();
  const state = createOAuthState();
  const codeVerifier = createCodeVerifier();
  const codeChallenge = createCodeChallenge(codeVerifier);
  savePkceState(state, codeVerifier);

  const params = new URLSearchParams({
    client_id: cfg.clientId,
    response_type: 'code',
    redirect_uri: cfg.redirectUri,
    response_mode: 'query',
    scope: MICROSOFT_SCOPES.join(' '),
    prompt: 'select_account',
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256'
  });

  return `${base}/authorize?${params.toString()}`;
}

async function parseJsonResponse(response, fallbackMessage) {
  const contentType = String(response.headers.get('content-type') || '').toLowerCase();
  if (contentType.includes('application/json')) {
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const message = payload?.error_description || payload?.error?.message || payload?.error || fallbackMessage;
      throw new Error(String(message || fallbackMessage));
    }
    return payload || {};
  }

  const text = await response.text().catch(() => '');
  if (!response.ok) {
    throw new Error(String(text || fallbackMessage));
  }

  return {};
}

async function parseResponsePayload(response) {
  const contentType = String(response.headers.get('content-type') || '').toLowerCase();
  if (contentType.includes('application/json')) {
    const json = await response.json().catch(() => null);
    return {
      json,
      text: ''
    };
  }

  return {
    json: null,
    text: await response.text().catch(() => '')
  };
}

function getOAuthErrorMessage({ status, json, text, fallbackMessage }) {
  const message =
    json?.error_description ||
    json?.error?.message ||
    json?.error ||
    String(text || '').trim() ||
    `${fallbackMessage} (${status})`;

  return String(message || fallbackMessage);
}

function normalizeMicrosoftTokenError(message) {
  const raw = String(message || '').trim();

  if (/AADSTS9002327/i.test(raw)) {
    return (
      'Microsoft app registration is configured as SPA. For this backend callback flow, add the redirect URI under Web platform ' +
      '(http://localhost:3000/auth/microsoft/callback) and remove it from SPA platform. Then retry Connect Microsoft Account.'
    );
  }

  return raw;
}

function normalizeTokenPayload(payload = {}, fallback = {}) {
  const expiresIn = Number(payload.expires_in || fallback.expires_in || 0);
  const expiresAt = expiresIn > 0 ? Date.now() + expiresIn * 1000 : Number(payload.expires_at || fallback.expires_at || 0) || null;

  return {
    ...fallback,
    ...payload,
    expires_at: expiresAt
  };
}

async function fetchMicrosoftMe(accessToken) {
  const response = await fetch('https://graph.microsoft.com/v1.0/me?$select=id,mail,userPrincipalName', {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  });

  const payload = await parseJsonResponse(response, 'Failed to read Microsoft account profile.');
  const email = String(payload.mail || payload.userPrincipalName || '').trim().toLowerCase();

  if (!email) {
    throw new Error('Unable to read Microsoft account email from OAuth callback.');
  }

  return {
    email
  };
}

async function requestMicrosoftToken(formData) {
  const cfg = getMicrosoftConfig();
  const base = getMicrosoftBaseAuthUrl();
  const clientSecret = String(cfg.clientSecret || '').trim();
  const includeSecretByDefault = Boolean(clientSecret);

  async function executeTokenRequest(includeSecret) {
    const body = new URLSearchParams({
      client_id: cfg.clientId,
      redirect_uri: cfg.redirectUri,
      ...formData
    });

    if (includeSecret && clientSecret) {
      body.set('client_secret', clientSecret);
    }

    const response = await fetch(`${base}/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body
    });

    const parsed = await parseResponsePayload(response);
    return { response, parsed };
  }

  let { response, parsed } = await executeTokenRequest(includeSecretByDefault);

  if (!response.ok && includeSecretByDefault) {
    const message = getOAuthErrorMessage({
      status: response.status,
      json: parsed.json,
      text: parsed.text,
      fallbackMessage: 'Failed to exchange Microsoft OAuth token.'
    });

    if (/AADSTS700025/i.test(message)) {
      ({ response, parsed } = await executeTokenRequest(false));
    }
  }

  if (!response.ok) {
    const message = getOAuthErrorMessage({
      status: response.status,
      json: parsed.json,
      text: parsed.text,
      fallbackMessage: 'Failed to exchange Microsoft OAuth token.'
    });
    throw new Error(normalizeMicrosoftTokenError(message));
  }

  return parsed.json || {};
}

async function exchangeCodeForUser(code, state) {
  const codeVerifier = consumePkceState(state);
  if (!codeVerifier) {
    throw new Error('Microsoft OAuth session expired or invalid state. Please click Connect Microsoft Account again.');
  }

  const tokenPayload = await requestMicrosoftToken({
    grant_type: 'authorization_code',
    code: String(code || '').trim(),
    code_verifier: codeVerifier
  });

  const tokens = normalizeTokenPayload(tokenPayload);
  const me = await fetchMicrosoftMe(tokens.access_token);

  return {
    email: me.email,
    tokens
  };
}

function willExpireSoon(tokens = {}, leewaySeconds = 60) {
  const expiresAt = Number(tokens.expires_at || 0);
  if (!expiresAt) {
    return false;
  }

  return Date.now() + leewaySeconds * 1000 >= expiresAt;
}

async function refreshMicrosoftTokens(tokens = {}) {
  const refreshToken = String(tokens.refresh_token || '').trim();
  if (!refreshToken) {
    throw new Error('Microsoft account is missing refresh token. Reconnect the account.');
  }

  const tokenPayload = await requestMicrosoftToken({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    scope: MICROSOFT_SCOPES.join(' ')
  });

  const normalized = normalizeTokenPayload(tokenPayload, tokens);
  if (!normalized.refresh_token) {
    normalized.refresh_token = refreshToken;
  }

  return normalized;
}

async function sendMailWithToken({ toEmail, subject, htmlBody, accessToken }) {
  const response = await fetch('https://graph.microsoft.com/v1.0/me/sendMail', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      message: {
        subject: String(subject || ''),
        body: {
          contentType: 'HTML',
          content: String(htmlBody || '')
        },
        toRecipients: [
          {
            emailAddress: {
              address: String(toEmail || '').trim()
            }
          }
        ]
      },
      saveToSentItems: true
    })
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    const message = payload?.error?.message || payload?.error_description || `Microsoft Graph sendMail failed (${response.status}).`;
    throw new Error(String(message));
  }

  return true;
}

async function sendMicrosoftEmail({ toEmail, subject, htmlBody, tokens }) {
  let activeTokens = { ...(tokens || {}) };

  if (!activeTokens.access_token || willExpireSoon(activeTokens)) {
    activeTokens = await refreshMicrosoftTokens(activeTokens);
  }

  try {
    await sendMailWithToken({
      toEmail,
      subject,
      htmlBody,
      accessToken: activeTokens.access_token
    });
  } catch (error) {
    const raw = String(error?.message || '').toLowerCase();
    const looksLikeTokenIssue =
      raw.includes('invalidauthenticationtoken') ||
      raw.includes('token') ||
      raw.includes('unauthorized') ||
      raw.includes('access denied');

    if (!looksLikeTokenIssue || !activeTokens.refresh_token) {
      throw error;
    }

    activeTokens = await refreshMicrosoftTokens(activeTokens);
    await sendMailWithToken({
      toEmail,
      subject,
      htmlBody,
      accessToken: activeTokens.access_token
    });
  }

  return {
    messageId: null,
    tokens: activeTokens
  };
}

module.exports = {
  hasMicrosoftConfig,
  getMicrosoftAuthUrl,
  exchangeCodeForUser,
  sendMicrosoftEmail
};
