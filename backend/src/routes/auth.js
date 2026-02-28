const express = require('express');
const {
  isDatabaseConnected,
  getActiveAccountEmail,
  getActiveSenderAccount,
  setActiveAccountEmail,
  saveGoogleAccount,
  saveMicrosoftAccount,
  saveSmtpAccount,
  getSmtpAccount,
  listConnectedAccounts,
  listSmtpAccounts,
  getConnectedAccount,
  disconnectConnectedAccount
} = require('../db');
const {
  hasGoogleConfig,
  getGoogleAuthUrl,
  exchangeCodeForUser,
  verifyGoogleSenderAlias
} = require('../services/google');
const {
  hasMicrosoftConfig,
  getMicrosoftAuthUrl,
  exchangeCodeForUser: exchangeMicrosoftCodeForUser
} = require('../services/microsoft');
const { verifySmtpConnection } = require('../services/smtp');
const { inferSmtpConfigCandidates, extractEmailDomain } = require('../services/smtpProfile');

const router = express.Router();

function getClientUrl() {
  return String(process.env.CLIENT_URL || 'http://localhost:5173').replace(/\/+$/, '');
}

function normalizeOAuthErrorMessage({ error, errorDescription, fallback }) {
  const code = String(error || '').trim();
  const description = String(errorDescription || '').trim();

  if (code && description) {
    return `${code}: ${description}`;
  }

  if (code) {
    return code;
  }

  if (description) {
    return description;
  }

  return String(fallback || 'oauth_failed');
}

function redirectWithOAuthError(res, clientUrl, provider, payload = {}) {
  const message = normalizeOAuthErrorMessage({
    error: payload.error,
    errorDescription: payload.errorDescription,
    fallback: payload.fallback || 'oauth_failed'
  });

  return res.redirect(
    `${clientUrl}/upload?oauth_provider=${encodeURIComponent(String(provider || 'oauth'))}&oauth_error=${encodeURIComponent(message)}`
  );
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function encodeStatePayload(payload = {}) {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeStatePayload(value) {
  const encoded = String(value || '').trim();
  if (!encoded) {
    return {};
  }

  try {
    const json = Buffer.from(encoded, 'base64url').toString('utf8');
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_error) {
    return {};
  }
}

function parsePort(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 1 || numeric > 65535) {
    return 465;
  }

  return Math.round(numeric);
}

function parseSecure(value, port) {
  if (typeof value === 'boolean') {
    return value;
  }

  const lowered = String(value || '').trim().toLowerCase();
  if (!lowered) {
    return Number(port || 465) === 465;
  }

  return !['false', '0', 'no', 'off'].includes(lowered);
}

function isMicrosoftTenantSmtpDisabled(message) {
  const lowered = String(message || '').toLowerCase();
  return (
    lowered.includes('smtpclientauthentication is disabled for the tenant') ||
    lowered.includes('smtp_auth_disabled') ||
    lowered.includes('5.7.139')
  );
}

function isDnsResolutionFailure(message) {
  const lowered = String(message || '').toLowerCase();
  return lowered.includes('enotfound') || lowered.includes('getaddrinfo');
}

function summarizeAttemptedHosts(configs = [], limit = 6) {
  const compact = configs
    .slice(0, limit)
    .map((item) => `${item.host}:${item.port}${item.secure ? '/ssl' : '/starttls'}`);

  return compact.join(', ');
}

function summarizeAttemptedUsernames(usernames = [], limit = 4) {
  return usernames.slice(0, limit).join(', ');
}

function looksLikeGoogleWorkspaceCandidates(configs = []) {
  return configs.some((item) => {
    const host = String(item?.host || '').toLowerCase();
    const source = String(item?.source || '').toLowerCase();
    return host.includes('smtp.gmail.com') || source.includes('google');
  });
}

function isMailboxMissingError(message) {
  const lowered = String(message || '').toLowerCase();
  return (
    lowered.includes('mailbox does not exist') ||
    lowered.includes('user unknown') ||
    lowered.includes('no such user') ||
    lowered.includes('5.1.1')
  );
}

function buildUsernameCandidates(email, username) {
  const provided = String(username || '').trim();
  if (provided) {
    return [provided];
  }

  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail || !normalizedEmail.includes('@')) {
    return normalizedEmail ? [normalizedEmail] : [];
  }

  const [localPart] = normalizedEmail.split('@');
  const candidates = [normalizedEmail];

  if (localPart && localPart !== normalizedEmail) {
    candidates.push(localPart);
  }

  return [...new Set(candidates)];
}

router.get('/api/auth/status', async (_req, res) => {
  if (!isDatabaseConnected()) {
    return res.json({
      connected: false,
      activeAccount: null,
      activeAccountDetails: null,
      accounts: [],
      hasGoogleConfig: hasGoogleConfig(),
      hasMicrosoftConfig: hasMicrosoftConfig(),
      supportsSmtp: true,
      databaseUnavailable: true
    });
  }

  try {
    const [activeAccount, accounts] = await Promise.all([getActiveSenderAccount(), listConnectedAccounts()]);

    res.json({
      connected: Boolean(activeAccount?.email),
      activeAccount: activeAccount?.email || null,
      activeAccountDetails: activeAccount ? { email: activeAccount.email, provider: activeAccount.provider } : null,
      accounts,
      hasGoogleConfig: hasGoogleConfig(),
      hasMicrosoftConfig: hasMicrosoftConfig(),
      supportsSmtp: true
    });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to load auth status.' });
  }
});

router.get('/api/auth/google/url', (req, res) => {
  if (!hasGoogleConfig()) {
    return res.status(400).json({
      error: 'Google OAuth is not configured. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REDIRECT_URI in .env.'
    });
  }

  try {
    const requestedSenderEmail = normalizeEmail(req.query?.senderEmail || req.query?.aliasEmail || '');
    const state = requestedSenderEmail ? encodeStatePayload({ senderEmail: requestedSenderEmail }) : undefined;
    const url = getGoogleAuthUrl({
      state,
      loginHint: requestedSenderEmail || undefined
    });
    return res.json({ url });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Could not create Google OAuth URL.' });
  }
});

router.get('/api/auth/microsoft/url', (_req, res) => {
  if (!hasMicrosoftConfig()) {
    return res.status(400).json({
      error:
        'Microsoft OAuth is not configured. Set MICROSOFT_CLIENT_ID, MICROSOFT_REDIRECT_URI (and optionally MICROSOFT_CLIENT_SECRET, MICROSOFT_TENANT_ID).'
    });
  }

  try {
    const url = getMicrosoftAuthUrl();
    return res.json({ url });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Could not create Microsoft OAuth URL.' });
  }
});

router.post('/api/auth/smtp/connect', async (req, res) => {
  if (!isDatabaseConnected()) {
    return res.status(503).json({ error: 'Database unavailable. Start MongoDB and retry.' });
  }

  const email = normalizeEmail(req.body?.email);
  const host = String(req.body?.host || '').trim().toLowerCase();
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');
  const fromName = String(req.body?.fromName || '').trim();
  const port = parsePort(req.body?.port);
  const secure = parseSecure(req.body?.secure, port);

  if (!email) {
    return res.status(400).json({ error: 'SMTP email is required.' });
  }

  if (!password) {
    return res.status(400).json({ error: 'SMTP password/app password is required.' });
  }

  try {
    let candidateConfigs = [];
    const usernameCandidates = buildUsernameCandidates(email, username);
    const manualConfigProvided = Boolean(host);

    if (manualConfigProvided) {
      candidateConfigs.push({
        host,
        port,
        secure
      });
    } else {
      candidateConfigs = await inferSmtpConfigCandidates(email);

      if (!candidateConfigs.length) {
        const domain = extractEmailDomain(email);
        if (domain) {
          candidateConfigs = [{ host: `smtp.${domain}`, port: 587, secure: false }];
        }
      }
    }

    if (!candidateConfigs.length) {
      return res.status(400).json({ error: 'Could not detect mail server for this email domain.' });
    }

    let verifiedConfig = null;
    let verifiedUsername = null;
    let lastError = null;
    let hasMailboxMissingError = false;
    const attemptedUsernames = new Set();

    for (const config of candidateConfigs) {
      for (const authUsername of usernameCandidates) {
        attemptedUsernames.add(authUsername);
        try {
          await verifySmtpConnection({
            fromEmail: email,
            host: config.host,
            port: config.port,
            secure: config.secure,
            username: authUsername,
            password
          });

          verifiedConfig = config;
          verifiedUsername = authUsername;
          break;
        } catch (verificationError) {
          lastError = verificationError;
          if (isMailboxMissingError(verificationError?.message)) {
            hasMailboxMissingError = true;
          }
          if (isMicrosoftTenantSmtpDisabled(verificationError?.message)) {
            return res.status(400).json({
              error:
                'Microsoft 365 has SMTP AUTH disabled for this tenant/account. Use "Connect Microsoft Account" OAuth, or ask your Microsoft admin to enable Authenticated SMTP (SmtpClientAuthentication).'
            });
          }
        }
      }

      if (verifiedConfig) {
        break;
      }
    }

    if (!verifiedConfig) {
      const detail = String(lastError?.message || '').trim() || 'Unable to sign in to SMTP server with this email/password.';
      const attemptedHosts = summarizeAttemptedHosts(candidateConfigs);
      const attemptedLoginUsers = summarizeAttemptedUsernames(Array.from(attemptedUsernames));

      if (hasMailboxMissingError) {
        if (looksLikeGoogleWorkspaceCandidates(candidateConfigs)) {
          return res.status(400).json({
            error:
              `Email verification failed for Google Workspace mailbox. This domain is Google-hosted, but this sender is not a direct SMTP-login mailbox. Use Connect Google Account and sign in with a real Google Workspace mailbox user. If sender is an alias/group (like services@...), configure and verify it in Gmail "Send mail as". Tried hosts: ${attemptedHosts}. Tried usernames: ${attemptedLoginUsers}`
          });
        }

        return res.status(400).json({
          error: `Email verification failed. Mailbox does not exist on detected SMTP servers. Verify sender email spelling and ensure mailbox is created with SMTP-login enabled. If sender is an alias/group, use SMTP Login Username with the primary mailbox user. Tried hosts: ${attemptedHosts}. Tried usernames: ${attemptedLoginUsers}`
        });
      }

      if (!manualConfigProvided && isDnsResolutionFailure(detail)) {
        return res.status(400).json({
          error: `Email verification failed. Could not auto-detect reachable SMTP host for this domain. Tried: ${attemptedHosts}. Check domain spelling in email, or connect with Google/Microsoft OAuth if this mailbox is hosted there.`
        });
      }

      return res.status(400).json({
        error: `Email verification failed. Please check email/password (or app password). Detail: ${detail}`
      });
    }

    const account = await saveSmtpAccount({
      email,
      host: verifiedConfig.host,
      port: verifiedConfig.port,
      secure: verifiedConfig.secure,
      username: verifiedUsername || email,
      password,
      fromName
    });

    await setActiveAccountEmail(account.email);
    const accounts = await listConnectedAccounts();

    return res.json({
      ok: true,
      account: {
        email: account.email,
        provider: 'smtp'
      },
      activeAccount: account.email,
      accounts
    });
  } catch (error) {
    const rawMessage = String(error?.message || '').trim();
    const lower = rawMessage.toLowerCase();

    if (isMicrosoftTenantSmtpDisabled(rawMessage)) {
      return res.status(400).json({
        error:
          'Microsoft 365 has SMTP AUTH disabled for this tenant/account. Use "Connect Microsoft Account" OAuth, or ask your Microsoft admin to enable Authenticated SMTP (SmtpClientAuthentication).'
      });
    }

    if (
      lower.includes('invalid login') ||
      lower.includes('authentication') ||
      lower.includes('auth') ||
      lower.includes('eauth') ||
      lower.includes('smtp password failed') ||
      lower.includes('smtp username failed') ||
      lower.includes('smtp 535') ||
      lower.includes('smtp 534') ||
      lower.includes('smtp 530') ||
      lower.includes('self signed certificate') ||
      lower.includes('certificate') ||
      lower.includes('getaddrinfo') ||
      lower.includes('enotfound') ||
      lower.includes('etimedout') ||
      lower.includes('econnrefused')
    ) {
      return res.status(400).json({
        error: `Email verification failed. Please check email/password (or app password). Detail: ${rawMessage || 'unknown'}`
      });
    }

    return res.status(500).json({ error: rawMessage || 'Failed to connect SMTP account.' });
  }
});

router.post('/api/auth/smtp/add-alias', async (req, res) => {
  if (!isDatabaseConnected()) {
    return res.status(503).json({ error: 'Database unavailable. Start MongoDB and retry.' });
  }

  const aliasEmail = normalizeEmail(req.body?.aliasEmail);
  const baseAccountEmail = normalizeEmail(req.body?.baseAccountEmail);
  const fromName = String(req.body?.fromName || '').trim();

  if (!aliasEmail || !aliasEmail.includes('@')) {
    return res.status(400).json({ error: 'Valid aliasEmail is required.' });
  }

  try {
    let baseSmtpAccount = null;

    if (baseAccountEmail) {
      baseSmtpAccount = await getSmtpAccount(baseAccountEmail);
      if (!baseSmtpAccount) {
        return res.status(404).json({ error: `Base SMTP account not found: ${baseAccountEmail}` });
      }
    } else {
      const activeEmail = await getActiveAccountEmail();
      if (activeEmail) {
        const activeAccount = await getConnectedAccount(activeEmail);
        if (activeAccount?.provider === 'smtp') {
          baseSmtpAccount = await getSmtpAccount(activeEmail);
        }
      }

      if (!baseSmtpAccount) {
        const smtpAccounts = await listSmtpAccounts();
        if (smtpAccounts.length > 0) {
          baseSmtpAccount = await getSmtpAccount(smtpAccounts[0].email);
        }
      }
    }

    if (!baseSmtpAccount) {
      return res.status(400).json({
        error:
          'No verified SMTP account found. First verify one SMTP login mailbox using email/password, then add alias sender email.'
      });
    }

    const account = await saveSmtpAccount({
      email: aliasEmail,
      host: baseSmtpAccount.host,
      port: baseSmtpAccount.port,
      secure: baseSmtpAccount.secure,
      username: baseSmtpAccount.username,
      password: baseSmtpAccount.password,
      fromName: fromName || baseSmtpAccount.from_name || ''
    });

    await setActiveAccountEmail(account.email);
    const accounts = await listConnectedAccounts();

    return res.json({
      ok: true,
      account: {
        email: account.email,
        provider: 'smtp',
        aliasOf: baseSmtpAccount.email
      },
      activeAccount: account.email,
      accounts
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Failed to add SMTP alias.' });
  }
});

router.post('/api/auth/select-account', async (req, res) => {
  if (!isDatabaseConnected()) {
    return res.status(503).json({ error: 'Database unavailable. Start MongoDB and retry.' });
  }

  const { email } = req.body || {};

  if (!email) {
    return res.status(400).json({ error: 'email is required.' });
  }

  try {
    const account = await getConnectedAccount(normalizeEmail(email));
    if (!account) {
      return res.status(404).json({ error: 'Account not found.' });
    }

    await setActiveAccountEmail(account.email);
    return res.json({ ok: true, activeAccount: account.email, activeProvider: account.provider });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Failed to change account.' });
  }
});

async function handleDisconnect(req, res) {
  if (!isDatabaseConnected()) {
    return res.status(503).json({ error: 'Database unavailable. Start MongoDB and retry.' });
  }

  const email = String(req.body?.email || '').trim().toLowerCase();

  try {
    const targetEmail = email || (await getActiveAccountEmail()) || '';
    if (!targetEmail) {
      return res.status(400).json({ error: 'No connected account to disconnect.' });
    }

    const result = await disconnectConnectedAccount(targetEmail);
    const accounts = await listConnectedAccounts();
    const activeAccount = await getActiveSenderAccount();

    return res.json({
      ok: true,
      disconnected: result.disconnected,
      disconnectedEmail: result.disconnectedEmail,
      activeAccount: activeAccount?.email || result.activeAccount || null,
      activeAccountDetails: activeAccount ? { email: activeAccount.email, provider: activeAccount.provider } : null,
      accounts
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Failed to disconnect account.' });
  }
}

router.post('/api/auth/disconnect', handleDisconnect);
router.post('/auth/disconnect', handleDisconnect);

router.get('/auth/google/callback', async (req, res) => {
  const { code, error, error_description: errorDescription, state } = req.query;
  const clientUrl = getClientUrl();

  if (error) {
    return redirectWithOAuthError(res, clientUrl, 'google', {
      error,
      errorDescription
    });
  }

  if (!code) {
    return res.redirect(`${clientUrl}/upload?oauth_error=missing_code`);
  }

  if (!isDatabaseConnected()) {
    return res.redirect(`${clientUrl}/upload?oauth_error=database_unavailable`);
  }

  try {
    const user = await exchangeCodeForUser(code);
    const statePayload = decodeStatePayload(state);
    const requestedSenderEmail = normalizeEmail(statePayload?.senderEmail || '');

    if (requestedSenderEmail && requestedSenderEmail !== user.email) {
      const aliasCheck = await verifyGoogleSenderAlias({
        senderEmail: requestedSenderEmail,
        tokens: user.tokens
      });

      if (!aliasCheck.ok) {
        const available = (aliasCheck.availableSenders || []).join(', ');
        const detail = aliasCheck.reason === 'not_verified'
          ? `Alias exists but is not verified yet (${aliasCheck.verificationStatus || 'unknown'}).`
          : `Signed-in Google account (${user.email}) cannot send as ${requestedSenderEmail}.`;
        const extra = available ? ` Available sender emails: ${available}` : '';
        return redirectWithOAuthError(res, clientUrl, 'google', {
          errorDescription: `Google sender verification failed for ${requestedSenderEmail}. ${detail} Sign in directly with ${requestedSenderEmail} account, or add it in Gmail Send As settings.${extra}`
        });
      }
    }

    await saveGoogleAccount(user.email, user.tokens);
    if (requestedSenderEmail) {
      await saveGoogleAccount(requestedSenderEmail, user.tokens);
      await setActiveAccountEmail(requestedSenderEmail);
    } else {
      await setActiveAccountEmail(user.email);
    }

    return res.redirect(
      `${clientUrl}/upload?connected=${encodeURIComponent(requestedSenderEmail || user.email)}&connected_provider=${encodeURIComponent('google')}`
    );
  } catch (callbackError) {
    return redirectWithOAuthError(res, clientUrl, 'google', {
      errorDescription: callbackError.message,
      fallback: 'oauth_callback_failed'
    });
  }
});

router.get('/auth/microsoft/callback', async (req, res) => {
  const { code, error, error_description: errorDescription, state } = req.query;
  const clientUrl = getClientUrl();

  if (error) {
    return redirectWithOAuthError(res, clientUrl, 'microsoft', {
      error,
      errorDescription
    });
  }

  if (!code) {
    return res.redirect(`${clientUrl}/upload?oauth_error=missing_code`);
  }

  if (!state) {
    return redirectWithOAuthError(res, clientUrl, 'microsoft', {
      fallback: 'missing_state'
    });
  }

  if (!isDatabaseConnected()) {
    return res.redirect(`${clientUrl}/upload?oauth_error=database_unavailable`);
  }

  try {
    const user = await exchangeMicrosoftCodeForUser(code, state);
    await saveMicrosoftAccount(user.email, user.tokens);
    await setActiveAccountEmail(user.email);

    return res.redirect(
      `${clientUrl}/upload?connected=${encodeURIComponent(user.email)}&connected_provider=${encodeURIComponent('microsoft')}`
    );
  } catch (callbackError) {
    return redirectWithOAuthError(res, clientUrl, 'microsoft', {
      errorDescription: callbackError.message,
      fallback: 'microsoft_oauth_callback_failed'
    });
  }
});

module.exports = router;
