const dns = require('dns').promises;

const GENERIC_PROVIDER_CANDIDATES = [
  { host: 'smtp.office365.com', port: 587, secure: false, source: 'generic-office365' },
  { host: 'smtp-mail.outlook.com', port: 587, secure: false, source: 'generic-outlook' },
  { host: 'smtp.gmail.com', port: 465, secure: true, source: 'generic-gmail-ssl' },
  { host: 'smtp.gmail.com', port: 587, secure: false, source: 'generic-gmail-starttls' },
  { host: 'smtp.zoho.com', port: 465, secure: true, source: 'generic-zoho' },
  { host: 'smtp.mail.yahoo.com', port: 465, secure: true, source: 'generic-yahoo' },
  { host: 'smtp.mail.me.com', port: 587, secure: false, source: 'generic-icloud' }
];

function extractEmailDomain(email) {
  const normalized = String(email || '').trim().toLowerCase();
  const parts = normalized.split('@');
  if (parts.length !== 2 || !parts[1]) {
    return '';
  }

  return parts[1];
}

function addCandidate(candidates, { host, port, secure, source }) {
  const cleanHost = String(host || '').trim().toLowerCase();
  const numericPort = Number(port || 0);
  const secureBool = Boolean(secure);

  if (!cleanHost || !Number.isFinite(numericPort) || numericPort < 1 || numericPort > 65535) {
    return;
  }

  const key = `${cleanHost}:${numericPort}:${secureBool ? '1' : '0'}`;
  if (candidates.some((item) => item.key === key)) {
    return;
  }

  candidates.push({
    key,
    host: cleanHost,
    port: numericPort,
    secure: secureBool,
    source: String(source || 'auto')
  });
}

function getRootDomain(domain) {
  const labels = String(domain || '')
    .trim()
    .toLowerCase()
    .split('.')
    .filter(Boolean);

  if (labels.length <= 2) {
    return labels.join('.');
  }

  return labels.slice(-2).join('.');
}

function addDomainBasedCandidates(domain, candidates, sourcePrefix = 'domain') {
  if (!domain) {
    return;
  }

  if (domain === 'gmail.com' || domain === 'googlemail.com') {
    addCandidate(candidates, { host: 'smtp.gmail.com', port: 465, secure: true, source: `${sourcePrefix}-google` });
    addCandidate(candidates, { host: 'smtp.gmail.com', port: 587, secure: false, source: `${sourcePrefix}-google-587` });
  }

  if (
    domain === 'outlook.com' ||
    domain === 'hotmail.com' ||
    domain === 'live.com' ||
    domain === 'msn.com' ||
    domain.endsWith('.outlook.com')
  ) {
    addCandidate(candidates, { host: 'smtp-mail.outlook.com', port: 587, secure: false, source: `${sourcePrefix}-outlook` });
    addCandidate(candidates, { host: 'smtp.office365.com', port: 587, secure: false, source: `${sourcePrefix}-office365` });
  }

  if (domain === 'zoho.com' || domain === 'zohomail.com' || domain.endsWith('.zoho.com')) {
    addCandidate(candidates, { host: 'smtp.zoho.com', port: 465, secure: true, source: `${sourcePrefix}-zoho` });
  }

  if (domain === 'yahoo.com' || domain === 'ymail.com' || domain.endsWith('.yahoodns.net')) {
    addCandidate(candidates, { host: 'smtp.mail.yahoo.com', port: 465, secure: true, source: `${sourcePrefix}-yahoo` });
  }

  if (domain === 'icloud.com' || domain === 'me.com' || domain === 'mac.com') {
    addCandidate(candidates, { host: 'smtp.mail.me.com', port: 587, secure: false, source: `${sourcePrefix}-icloud` });
  }
}

function addMxBasedCandidate(exchange, candidates) {
  const host = String(exchange || '').trim().toLowerCase();
  if (!host) {
    return;
  }

  if (host.includes('google.com') || host.includes('googlemail.com')) {
    addCandidate(candidates, { host: 'smtp.gmail.com', port: 465, secure: true, source: 'mx-google' });
    addCandidate(candidates, { host: 'smtp.gmail.com', port: 587, secure: false, source: 'mx-google-587' });
  } else if (host.includes('outlook.com') || host.includes('office365.com') || host.includes('protection.outlook.com')) {
    addCandidate(candidates, { host: 'smtp.office365.com', port: 587, secure: false, source: 'mx-office365' });
    addCandidate(candidates, { host: 'smtp-mail.outlook.com', port: 587, secure: false, source: 'mx-outlook' });
  } else if (host.includes('zoho')) {
    if (host.includes('zoho.in')) {
      addCandidate(candidates, { host: 'smtp.zoho.in', port: 465, secure: true, source: 'mx-zoho-in' });
    } else if (host.includes('zoho.eu')) {
      addCandidate(candidates, { host: 'smtp.zoho.eu', port: 465, secure: true, source: 'mx-zoho-eu' });
    }
    addCandidate(candidates, { host: 'smtp.zoho.com', port: 465, secure: true, source: 'mx-zoho' });
  } else if (host.includes('yahoodns.net')) {
    addCandidate(candidates, { host: 'smtp.mail.yahoo.com', port: 465, secure: true, source: 'mx-yahoo' });
  } else if (host.includes('secureserver.net')) {
    addCandidate(candidates, { host: 'smtpout.secureserver.net', port: 465, secure: true, source: 'mx-secureserver' });
  }
}

async function resolveMxSafe(domain) {
  if (!domain) {
    return [];
  }

  try {
    return await dns.resolveMx(domain);
  } catch (_error) {
    return [];
  }
}

async function resolveSrvSafe(recordName) {
  if (!recordName) {
    return [];
  }

  try {
    return await dns.resolveSrv(recordName);
  } catch (_error) {
    return [];
  }
}

function addSrvBasedCandidates(records, candidates, secure, source) {
  if (!Array.isArray(records)) {
    return;
  }

  const ordered = [...records].sort((a, b) => Number(a.priority || 0) - Number(b.priority || 0));
  for (const record of ordered.slice(0, 4)) {
    addCandidate(candidates, {
      host: record.name,
      port: Number(record.port || (secure ? 465 : 587)),
      secure,
      source
    });
  }
}

function addDomainHostCandidates(domain, candidates, sourcePrefix) {
  if (!domain) {
    return;
  }

  addCandidate(candidates, { host: `smtp.${domain}`, port: 465, secure: true, source: `${sourcePrefix}-smtp-ssl` });
  addCandidate(candidates, { host: `smtp.${domain}`, port: 587, secure: false, source: `${sourcePrefix}-smtp-starttls` });
  addCandidate(candidates, { host: `mail.${domain}`, port: 465, secure: true, source: `${sourcePrefix}-mail-ssl` });
  addCandidate(candidates, { host: `mail.${domain}`, port: 587, secure: false, source: `${sourcePrefix}-mail-starttls` });
  addCandidate(candidates, { host: `email.${domain}`, port: 587, secure: false, source: `${sourcePrefix}-email-starttls` });
}

async function inferSmtpConfigCandidates(email) {
  const domain = extractEmailDomain(email);
  const rootDomain = getRootDomain(domain);
  const candidates = [];

  addDomainBasedCandidates(domain, candidates);
  if (rootDomain && rootDomain !== domain) {
    addDomainBasedCandidates(rootDomain, candidates, 'root-domain');
  }

  if (domain) {
    const mxDomains = rootDomain && rootDomain !== domain ? [domain, rootDomain] : [domain];
    for (const mxDomain of mxDomains) {
      const mxRecords = await resolveMxSafe(mxDomain);
      const ordered = [...mxRecords].sort((a, b) => Number(a.priority || 0) - Number(b.priority || 0));
      for (const record of ordered.slice(0, 5)) {
        addMxBasedCandidate(record.exchange, candidates);
      }

      const submissionSrv = await resolveSrvSafe(`_submission._tcp.${mxDomain}`);
      addSrvBasedCandidates(submissionSrv, candidates, false, `srv-submission-${mxDomain}`);

      const smtpsSrv = await resolveSrvSafe(`_smtps._tcp.${mxDomain}`);
      addSrvBasedCandidates(smtpsSrv, candidates, true, `srv-smtps-${mxDomain}`);
    }

    addDomainHostCandidates(domain, candidates, 'fallback-domain');
    if (rootDomain && rootDomain !== domain) {
      addDomainHostCandidates(rootDomain, candidates, 'fallback-root-domain');
    }
  }

  for (const provider of GENERIC_PROVIDER_CANDIDATES) {
    addCandidate(candidates, provider);
  }

  return candidates.map(({ key, ...rest }) => rest);
}

module.exports = {
  inferSmtpConfigCandidates,
  extractEmailDomain
};
