function normalizeDomain(domain) {
  return String(domain || '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '')
    .toLowerCase();
}

function normalizeUrl(url) {
  const value = String(url || '').trim();
  if (!value) {
    return '';
  }

  return /^https?:\/\//i.test(value) ? value : `https://${value}`;
}

export function getEmailCenterUrl({ provider = 'google', domain = '', customUrl = '' } = {}) {
  const key = String(provider || '').trim().toLowerCase();

  if (key === 'google') {
    return 'https://accounts.google.com/';
  }

  if (key === 'outlook_personal') {
    return 'https://outlook.live.com/mail/';
  }

  if (key === 'outlook_work') {
    return 'https://outlook.office.com/mail/';
  }

  // Backward compatibility for older saved value.
  if (key === 'microsoft') {
    return 'https://outlook.office.com/mail/';
  }

  if (key === 'zoho') {
    return 'https://accounts.zoho.com/signin';
  }

  if (key === 'hostinger') {
    return 'https://hpanel.hostinger.com/';
  }

  if (key === 'domain_webmail') {
    const normalizedDomain = normalizeDomain(domain);
    return normalizedDomain ? `https://mail.${normalizedDomain}` : '';
  }

  if (key === 'custom') {
    return normalizeUrl(customUrl);
  }

  return '';
}
