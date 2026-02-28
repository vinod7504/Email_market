const { google } = require('googleapis');

const GOOGLE_SCOPES = [
  'openid',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/gmail.send'
];

function getGoogleConfig() {
  return {
    clientId: process.env.GOOGLE_CLIENT_ID || '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
    redirectUri: process.env.GOOGLE_REDIRECT_URI || ''
  };
}

function hasGoogleConfig() {
  const cfg = getGoogleConfig();
  return Boolean(cfg.clientId && cfg.clientSecret && cfg.redirectUri);
}

function createOAuthClient() {
  const cfg = getGoogleConfig();
  if (!cfg.clientId || !cfg.clientSecret || !cfg.redirectUri) {
    throw new Error('Google OAuth config is missing. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REDIRECT_URI.');
  }

  return new google.auth.OAuth2(cfg.clientId, cfg.clientSecret, cfg.redirectUri);
}

function getGoogleAuthUrl() {
  const options = arguments.length > 0 && arguments[0] ? arguments[0] : {};
  const oauth2Client = createOAuthClient();
  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'select_account consent',
    include_granted_scopes: true,
    scope: [...GOOGLE_SCOPES, 'https://www.googleapis.com/auth/gmail.settings.basic'],
    state: options.state ? String(options.state) : undefined,
    login_hint: options.loginHint ? String(options.loginHint) : undefined
  });
}

async function exchangeCodeForUser(code) {
  const oauth2Client = createOAuthClient();
  const { tokens } = await oauth2Client.getToken(code);
  oauth2Client.setCredentials(tokens);

  const oauth2 = google.oauth2({
    auth: oauth2Client,
    version: 'v2'
  });

  const userInfoResponse = await oauth2.userinfo.get();
  const email = userInfoResponse.data.email;

  if (!email) {
    throw new Error('Unable to read Google account email from OAuth callback.');
  }

  return {
    email,
    tokens
  };
}

function buildRawMessage({ fromEmail, toEmail, subject, htmlBody }) {
  const subjectBase64 = Buffer.from(String(subject || ''), 'utf8').toString('base64');
  const htmlBase64 = Buffer.from(String(htmlBody || ''), 'utf8').toString('base64');

  const message = [
    `From: ${fromEmail}`,
    `To: ${toEmail}`,
    `Subject: =?UTF-8?B?${subjectBase64}?=`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    htmlBase64
  ].join('\r\n');

  return Buffer.from(message, 'utf8').toString('base64url');
}

async function sendGmailEmail({ fromEmail, toEmail, subject, htmlBody, tokens }) {
  const oauth2Client = createOAuthClient();
  oauth2Client.setCredentials(tokens);

  const gmail = google.gmail({
    version: 'v1',
    auth: oauth2Client
  });

  const raw = buildRawMessage({ fromEmail, toEmail, subject, htmlBody });

  const response = await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw }
  });

  const refreshed = {
    ...tokens,
    ...oauth2Client.credentials
  };

  if (!refreshed.refresh_token && tokens.refresh_token) {
    refreshed.refresh_token = tokens.refresh_token;
  }

  return {
    messageId: response.data.id,
    tokens: refreshed
  };
}

async function verifyGoogleSenderAlias({ senderEmail, tokens }) {
  const normalizedSender = String(senderEmail || '').trim().toLowerCase();
  if (!normalizedSender) {
    return {
      ok: false,
      reason: 'missing_sender_email'
    };
  }

  const oauth2Client = createOAuthClient();
  oauth2Client.setCredentials(tokens);

  const gmail = google.gmail({
    version: 'v1',
    auth: oauth2Client
  });

  const response = await gmail.users.settings.sendAs.list({
    userId: 'me'
  });

  const sendAsList = Array.isArray(response?.data?.sendAs) ? response.data.sendAs : [];
  const matched = sendAsList.find((entry) => String(entry?.sendAsEmail || '').trim().toLowerCase() === normalizedSender);

  if (!matched) {
    return {
      ok: false,
      reason: 'not_found',
      availableSenders: sendAsList.map((entry) => String(entry?.sendAsEmail || '').trim()).filter(Boolean)
    };
  }

  const verificationStatus = String(matched.verificationStatus || '').trim().toLowerCase();
  const accepted = matched.isPrimary || !verificationStatus || verificationStatus === 'accepted' || verificationStatus === 'verified';

  if (!accepted) {
    return {
      ok: false,
      reason: 'not_verified',
      verificationStatus: matched.verificationStatus || 'unknown'
    };
  }

  return {
    ok: true,
    senderEmail: matched.sendAsEmail
  };
}

module.exports = {
  hasGoogleConfig,
  getGoogleAuthUrl,
  exchangeCodeForUser,
  sendGmailEmail,
  verifyGoogleSenderAlias
};
