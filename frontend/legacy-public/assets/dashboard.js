const els = {
  dashboardAccountBadge: document.getElementById('dashboardAccountBadge'),
  refreshBtn: document.getElementById('refreshBtn'),
  kpiCampaigns: document.getElementById('kpiCampaigns'),
  kpiSent: document.getElementById('kpiSent'),
  kpiOpened: document.getElementById('kpiOpened'),
  kpiOpenRate: document.getElementById('kpiOpenRate'),
  campaignTableBody: document.getElementById('campaignTableBody'),
  campaignTableNotice: document.getElementById('campaignTableNotice'),
  recipientTableBody: document.getElementById('recipientTableBody'),
  recipientsTitle: document.getElementById('recipientsTitle'),
  recipientsSubtitle: document.getElementById('recipientsSubtitle')
};

let selectedCampaignId = null;
let latestCampaigns = [];

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

function showNotice(message, type = 'info') {
  els.campaignTableNotice.textContent = message;
  els.campaignTableNotice.className = `notice ${type === 'error' ? 'error' : type === 'success' ? 'success' : ''}`.trim();
  els.campaignTableNotice.style.display = 'block';
}

function hideNotice() {
  els.campaignTableNotice.style.display = 'none';
}

function statusBadge(status) {
  const key = String(status || '').toLowerCase();
  return `<span class="badge badge-${key}">${escapeHtml(status || 'UNKNOWN')}</span>`;
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const body = await response.json();

  if (!response.ok) {
    throw new Error(body.error || 'Request failed');
  }

  return body;
}

function renderAccountBadge(auth) {
  if (auth.connected && auth.activeAccount) {
    els.dashboardAccountBadge.className = 'badge badge-low';
    els.dashboardAccountBadge.textContent = auth.activeAccount;
  } else {
    els.dashboardAccountBadge.className = 'badge badge-high';
    els.dashboardAccountBadge.textContent = 'No account connected';
  }
}

function updateKpis(campaigns) {
  const campaignCount = campaigns.length;
  const sentTotal = campaigns.reduce((sum, c) => sum + Number(c.sent_count || 0), 0);
  const openedTotal = campaigns.reduce((sum, c) => sum + Number(c.opened_count || 0), 0);
  const openRate = sentTotal > 0 ? ((openedTotal / sentTotal) * 100).toFixed(1) : '0.0';

  els.kpiCampaigns.textContent = String(campaignCount);
  els.kpiSent.textContent = String(sentTotal);
  els.kpiOpened.textContent = String(openedTotal);
  els.kpiOpenRate.textContent = `${openRate}%`;
}

function renderCampaignTable(campaigns) {
  if (!campaigns.length) {
    els.campaignTableBody.innerHTML = '<tr><td colspan="7">No campaigns found.</td></tr>';
    return;
  }

  els.campaignTableBody.innerHTML = campaigns
    .map((campaign) => {
      const sent = Number(campaign.sent_count || 0);
      const opened = Number(campaign.opened_count || 0);
      const failed = Number(campaign.failed_count || 0);
      const canSendNow = ['SCHEDULED', 'QUEUED', 'FAILED', 'PARTIAL'].includes(campaign.status);

      return `
        <tr>
          <td><span class="table-link" data-action="view" data-id="${campaign.id}">${escapeHtml(campaign.name)}</span></td>
          <td>${statusBadge(campaign.status)}</td>
          <td>${formatDate(campaign.scheduled_at || campaign.created_at)}</td>
          <td>${sent}/${Number(campaign.total_recipients || 0)}</td>
          <td>${opened}</td>
          <td>${failed}</td>
          <td>
            ${canSendNow ? `<button class="btn btn-warning" data-action="send-now" data-id="${campaign.id}">Send Now</button>` : '-'}
          </td>
        </tr>
      `;
    })
    .join('');
}

async function sendNow(campaignId) {
  try {
    await fetchJson(`/api/campaigns/${campaignId}/send-now`, { method: 'POST' });
    showNotice('Campaign queued for immediate send.', 'success');
    await loadDashboard();
  } catch (error) {
    showNotice(error.message, 'error');
  }
}

function renderRecipients(data) {
  const campaign = data.campaign;
  const recipients = data.recipients || [];

  els.recipientsTitle.textContent = `Recipients · ${campaign.name}`;
  els.recipientsSubtitle.textContent = `${recipients.length} recipients in this campaign.`;

  if (!recipients.length) {
    els.recipientTableBody.innerHTML = '<tr><td colspan="4">No recipients in this campaign.</td></tr>';
    return;
  }

  els.recipientTableBody.innerHTML = recipients
    .map((recipient) => {
      return `
        <tr>
          <td>${escapeHtml(recipient.email)}</td>
          <td>${statusBadge(recipient.status)}</td>
          <td>${formatDate(recipient.sent_at)}</td>
          <td>${formatDate(recipient.opened_at)}</td>
        </tr>
        ${recipient.error ? `<tr><td colspan="4"><small class="muted">Error: ${escapeHtml(recipient.error)}</small></td></tr>` : ''}
      `;
    })
    .join('');
}

async function loadRecipients(campaignId) {
  selectedCampaignId = Number(campaignId);

  try {
    const data = await fetchJson(`/api/campaigns/${campaignId}/recipients`);
    renderRecipients(data);
  } catch (error) {
    els.recipientsSubtitle.textContent = error.message;
  }
}

async function loadDashboard() {
  hideNotice();

  try {
    const [auth, campaignsData] = await Promise.all([
      fetchJson('/api/auth/status'),
      fetchJson('/api/campaigns')
    ]);

    renderAccountBadge(auth);

    latestCampaigns = campaignsData.campaigns || [];
    updateKpis(latestCampaigns);
    renderCampaignTable(latestCampaigns);

    if (selectedCampaignId) {
      const stillExists = latestCampaigns.some((c) => Number(c.id) === Number(selectedCampaignId));
      if (stillExists) {
        await loadRecipients(selectedCampaignId);
      }
    }
  } catch (error) {
    showNotice(error.message, 'error');
  }
}

function attachEvents() {
  els.refreshBtn.addEventListener('click', () => {
    loadDashboard();
  });

  els.campaignTableBody.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }

    const action = target.dataset.action;
    const id = target.dataset.id;

    if (!action || !id) {
      return;
    }

    if (action === 'view') {
      loadRecipients(Number(id));
    }

    if (action === 'send-now') {
      sendNow(Number(id));
    }
  });
}

async function init() {
  attachEvents();
  await loadDashboard();

  setInterval(() => {
    loadDashboard();
  }, 15000);
}

init();
