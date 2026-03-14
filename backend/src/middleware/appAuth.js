const { getAppSessionByToken } = require('../db');

function parseBearerToken(headerValue) {
  const raw = String(headerValue || '').trim();
  if (!raw) {
    return '';
  }

  const match = raw.match(/^Bearer\s+(.+)$/i);
  if (!match || !match[1]) {
    return '';
  }

  return String(match[1]).trim();
}

function isAdminUser(user) {
  return String(user?.role || '').toLowerCase() === 'admin';
}

async function attachAppUserFromToken(req, _res, next) {
  req.appUser = null;
  req.appAuthToken = '';

  const token = parseBearerToken(req.get('authorization'));
  if (!token) {
    return next();
  }

  req.appAuthToken = token;

  try {
    const session = await getAppSessionByToken(token);
    if (!session) {
      return next();
    }

    req.appUser = {
      email: session.email,
      role: session.role,
      isAdmin: isAdminUser(session),
      expiresAt: session.expiresAt
    };
  } catch (error) {
    console.error('Failed to resolve app session:', error);
  }

  return next();
}

function requireAppUser(req, res, next) {
  if (!req.appUser) {
    return res.status(401).json({ error: 'Login required.' });
  }

  return next();
}

module.exports = {
  attachAppUserFromToken,
  parseBearerToken,
  requireAppUser,
  isAdminUser
};
