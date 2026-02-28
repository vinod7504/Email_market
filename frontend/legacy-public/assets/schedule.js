const els = {
  activeAccountBadge: document.getElementById('activeAccountBadge'),
  accountSelect: document.getElementById('accountSelect'),
  connectGoogleBtn: document.getElementById('connectGoogleBtn'),
  publicBaseUrl: document.getElementById('publicBaseUrl'),
  saveBaseUrlBtn: document.getElementById('saveBaseUrlBtn'),
  connectionNotice: document.getElementById('connectionNotice'),
  excelFile: document.getElementById('excelFile'),
  previewBox: document.getElementById('previewBox'),
  campaignForm: document.getElementById('campaignForm'),
  campaignNotice: document.getElementById('campaignNotice'),
  subject: document.getElementById('subject'),
  body: document.getElementById('body'),
  spamBadge: document.getElementById('spamBadge'),
  spamMeterFill: document.getElementById('spamMeterFill'),
  spamReason: document.getElementById('spamReason'),
  recentCampaignTableBody: document.getElementById('recentCampaignTableBody'),
  submitCampaignBtn: document.getElementById('submitCampaignBtn')
};

let currentAuth = null;

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatDate(value) {
  if (!value) {
    return '-';
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '-';
  }

  return date.toLocaleString();
}

function showNotice(element, message, type = 'info') {
  element.textContent = message;
  element.className = `notice ${type === 'error' ? 'error' : type === 'success' ? 'success' : ''}`.trim();
  element.style.display = 'block';
}

function hideNotice(element) {
  element.style.display = 'none';
}

function statusBadge(status) {
  const key = String(status || '').toLowerCase();
  return `<span class="badge badge-${key}">${escapeHtml(status || 'UNKNOWN')}</span>`;
}

function debounce(fn, wait) {
  let timeout = null;

  return (...args) => {
    clearTimeout(timeout);
    timeout = setTimeout(() => fn(...args), wait);
  };
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const body = await response.json();

  if (!response.ok) {
    throw new Error(body.error || 'Request failed');
  }

  return body;
}

function renderAccountStatus(auth) {
  if (auth.connected && auth.activeAccount) {
    els.activeAccountBadge.className = 'badge badge-low';
    els.activeAccountBadge.textContent = `Connected: ${auth.activeAccount}`;
  } else {
    els.activeAccountBadge.className = 'badge badge-medium';
    els.activeAccountBadge.textContent = 'No account connected';
  }
}

function renderAccountSelect(auth) {
  const options = auth.accounts || [];

  if (!options.length) {
    els.accountSelect.innerHTML = '<option value="">No account connected yet</option>';
    return;
  }

  els.accountSelect.innerHTML = options
    .map((account) => {
      const selected = account.is_active ? 'selected' : '';
      return `<option value="${escapeHtml(account.email)}" ${selected}>${escapeHtml(account.email)}</option>`;
    })
    .join('');
}

async function loadAuth() {
  const auth = await fetchJson('/api/auth/status');
  currentAuth = auth;

  renderAccountStatus(auth);
  renderAccountSelect(auth);

  if (!auth.hasGoogleConfig) {
    showNotice(
      els.connectionNotice,
      'Google OAuth is not configured. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REDIRECT_URI in .env.',
      'error'
    );
  }
}

async function loadConfig() {
  const config = await fetchJson('/api/config');
  if (config.publicBaseUrl) {
    els.publicBaseUrl.value = config.publicBaseUrl;
  }
}

async function loadRecentCampaigns() {
  const response = await fetchJson('/api/campaigns');
  const campaigns = response.campaigns || [];

  if (!campaigns.length) {
    els.recentCampaignTableBody.innerHTML = '<tr><td colspan="3">No campaigns yet.</td></tr>';
    return;
  }

  els.recentCampaignTableBody.innerHTML = campaigns
    .slice(0, 7)
    .map((campaign) => {
      return `
        <tr>
          <td>${escapeHtml(campaign.name)}</td>
          <td>${statusBadge(campaign.status)}</td>
          <td>${Number(campaign.total_recipients || 0)}</td>
        </tr>
      `;
    })
    .join('');
}

async function previewRecipients() {
  const file = els.excelFile.files?.[0];
  if (!file) {
    els.previewBox.style.display = 'none';
    return;
  }

  const formData = new FormData();
  formData.append('excelFile', file);

  try {
    const data = await fetchJson('/api/recipients/preview', {
      method: 'POST',
      body: formData
    });

    const emails = data.emails || [];
    els.previewBox.style.display = 'block';
    els.previewBox.innerHTML = `
      <div class="preview-item"><strong>${data.total}</strong> recipients detected</div>
      ${emails.map((email) => `<div class="preview-item">${escapeHtml(email)}</div>`).join('')}
      ${data.total > emails.length ? `<div class="preview-item">...and ${data.total - emails.length} more</div>` : ''}
    `;
  } catch (error) {
    showNotice(els.campaignNotice, error.message, 'error');
    els.previewBox.style.display = 'none';
  }
}

function updateSpamUI(spam) {
  const label = String(spam.label || 'Low').toLowerCase();
  const className = label === 'high' ? 'badge-high' : label === 'medium' ? 'badge-medium' : 'badge-low';

  els.spamBadge.className = `badge ${className}`;
  els.spamBadge.textContent = `${spam.label} Risk · ${spam.score}/100`;
  els.spamMeterFill.style.width = `${spam.score}%`;
  els.spamReason.textContent = spam.reasons?.length ? spam.reasons.join(' | ') : 'No issues detected.';
}

const refreshSpamScore = debounce(async () => {
  const subject = els.subject.value || '';
  const body = els.body.value || '';

  try {
    const params = new URLSearchParams({ subject, body });
    const spam = await fetchJson(`/api/spam-score?${params.toString()}`);
    updateSpamUI(spam);
  } catch (_error) {
    // Ignore transient spam score errors.
  }
}, 350);

async function createCampaign(event) {
  event.preventDefault();
  hideNotice(els.campaignNotice);

  if (!currentAuth?.connected) {
    showNotice(els.campaignNotice, 'Connect a Google account before creating campaigns.', 'error');
    return;
  }

  const formData = new FormData(els.campaignForm);
  if (!formData.get('excelFile')) {
    showNotice(els.campaignNotice, 'Please upload an Excel file first.', 'error');
    return;
  }

  els.submitCampaignBtn.disabled = true;
  els.submitCampaignBtn.textContent = 'Creating...';

  try {
    const result = await fetchJson('/api/campaigns', {
      method: 'POST',
      body: formData
    });

    const mode = result.campaign.status === 'SCHEDULED' ? 'scheduled' : 'queued for sending';
    showNotice(
      els.campaignNotice,
      `Campaign created successfully (${result.recipientCount} recipients), ${mode}.`,
      'success'
    );

    await loadRecentCampaigns();
  } catch (error) {
    showNotice(els.campaignNotice, error.message, 'error');
  } finally {
    els.submitCampaignBtn.disabled = false;
    els.submitCampaignBtn.textContent = 'Create Campaign';
  }
}

async function savePublicBaseUrl() {
  hideNotice(els.connectionNotice);

  const url = els.publicBaseUrl.value.trim();
  if (!url) {
    showNotice(els.connectionNotice, 'Provide your ngrok/public URL first.', 'error');
    return;
  }

  try {
    await fetchJson('/api/settings/public-base-url', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ url })
    });

    showNotice(els.connectionNotice, 'Tracking URL saved.', 'success');
  } catch (error) {
    showNotice(els.connectionNotice, error.message, 'error');
  }
}

async function connectGoogle() {
  hideNotice(els.connectionNotice);

  try {
    const response = await fetchJson('/api/auth/google/url');
    window.location.href = response.url;
  } catch (error) {
    showNotice(els.connectionNotice, error.message, 'error');
  }
}

async function onAccountSelectChange() {
  const email = els.accountSelect.value;
  if (!email) {
    return;
  }

  try {
    await fetchJson('/api/auth/select-account', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ email })
    });

    await loadAuth();
    showNotice(els.connectionNotice, `Active account changed to ${email}`, 'success');
  } catch (error) {
    showNotice(els.connectionNotice, error.message, 'error');
  }
}

function handleQueryMessages() {
  const params = new URLSearchParams(window.location.search);
  const connected = params.get('connected');
  const oauthError = params.get('oauth_error');

  if (connected) {
    showNotice(els.connectionNotice, `Google account connected: ${connected}`, 'success');
  }

  if (oauthError) {
    showNotice(els.connectionNotice, `Google OAuth failed: ${oauthError}`, 'error');
  }
}

async function init() {
  handleQueryMessages();

  try {
    await Promise.all([loadAuth(), loadConfig(), loadRecentCampaigns()]);
  } catch (error) {
    showNotice(els.campaignNotice, error.message, 'error');
  }

  refreshSpamScore();

  els.connectGoogleBtn.addEventListener('click', connectGoogle);
  els.saveBaseUrlBtn.addEventListener('click', savePublicBaseUrl);
  els.accountSelect.addEventListener('change', onAccountSelectChange);
  els.excelFile.addEventListener('change', previewRecipients);
  els.subject.addEventListener('input', refreshSpamScore);
  els.body.addEventListener('input', refreshSpamScore);
  els.campaignForm.addEventListener('submit', createCampaign);
}

init();
