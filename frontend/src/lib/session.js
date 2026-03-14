const SESSION_STORAGE_KEY = 'mailpilot_app_session';

function hasWindow() {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

export function readStoredSession() {
  if (!hasWindow()) {
    return null;
  }

  const raw = window.localStorage.getItem(SESSION_STORAGE_KEY);
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw);
    const token = String(parsed?.token || '').trim();
    const userEmail = String(parsed?.user?.email || '').trim().toLowerCase();
    if (!token || !userEmail) {
      return null;
    }

    return {
      token,
      expiresAt: parsed?.expiresAt || null,
      user: {
        email: userEmail,
        role: String(parsed?.user?.role || 'user').toLowerCase() === 'admin' ? 'admin' : 'user',
        isAdmin: Boolean(parsed?.user?.isAdmin || String(parsed?.user?.role || '').toLowerCase() === 'admin')
      }
    };
  } catch (_error) {
    return null;
  }
}

export function saveSession(session) {
  if (!hasWindow()) {
    return;
  }

  if (!session || !session.token || !session.user?.email) {
    window.localStorage.removeItem(SESSION_STORAGE_KEY);
    return;
  }

  window.localStorage.setItem(
    SESSION_STORAGE_KEY,
    JSON.stringify({
      token: String(session.token),
      expiresAt: session.expiresAt || null,
      user: {
        email: String(session.user.email || '').toLowerCase(),
        role: String(session.user.role || 'user').toLowerCase() === 'admin' ? 'admin' : 'user',
        isAdmin: Boolean(session.user.isAdmin)
      }
    })
  );
}

export function clearSession() {
  if (!hasWindow()) {
    return;
  }

  window.localStorage.removeItem(SESSION_STORAGE_KEY);
}

export function getSessionToken() {
  return readStoredSession()?.token || '';
}
