import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import AppLayout from '../components/AppLayout';
import { fetchJson, formatDateTime, resolveApiUrl, withAuthHeaders } from '../lib/api';

function statusBadgeClass(status) {
  const key = String(status || '').toLowerCase();
  return `badge badge-${key}`;
}

function Notice({ notice }) {
  if (!notice) {
    return null;
  }

  const className = notice.type === 'error' ? 'notice error' : notice.type === 'success' ? 'notice success' : 'notice';
  return <div className={className}>{notice.message}</div>;
}

const RECIPIENTS_PAGE_SIZE = 250;
const SELECTED_CAMPAIGN_STORAGE_PREFIX = 'mailpilot_selected_campaign:';

function normalizeCampaignId(value) {
  const normalized = String(value || '').trim();
  return normalized || null;
}

function getSelectedCampaignStorageKey(user) {
  const userEmail = String(user?.email || '').trim().toLowerCase();
  return `${SELECTED_CAMPAIGN_STORAGE_PREFIX}${userEmail || 'unknown'}`;
}

function readStoredSelectedCampaignId(user) {
  if (typeof window === 'undefined' || !window.localStorage) {
    return '';
  }

  const key = getSelectedCampaignStorageKey(user);
  return String(window.localStorage.getItem(key) || '').trim();
}

function writeStoredSelectedCampaignId(user, campaignId) {
  if (typeof window === 'undefined' || !window.localStorage) {
    return;
  }

  const key = getSelectedCampaignStorageKey(user);
  const normalizedCampaignId = String(campaignId || '').trim();
  if (!normalizedCampaignId) {
    window.localStorage.removeItem(key);
    return;
  }

  window.localStorage.setItem(key, normalizedCampaignId);
}

export default function DashboardPage({ appUser, onLogout }) {
  const location = useLocation();
  const [auth, setAuth] = useState({ connected: false, activeAccount: null, activeAccountDetails: null });
  const [campaigns, setCampaigns] = useState([]);
  const [selectedCampaignId, setSelectedCampaignId] = useState(() =>
    normalizeCampaignId(readStoredSelectedCampaignId(appUser))
  );
  const [selectedCampaign, setSelectedCampaign] = useState(null);
  const [recipients, setRecipients] = useState([]);
  const [recipientPagination, setRecipientPagination] = useState({
    page: 1,
    limit: RECIPIENTS_PAGE_SIZE,
    total: 0,
    totalPages: 1,
    hasNextPage: false,
    hasPreviousPage: false
  });
  const [isExporting, setIsExporting] = useState(false);
  const [notice, setNotice] = useState(null);
  const selectedCampaignIdRef = useRef(selectedCampaignId);
  const recipientsRequestRef = useRef(0);
  const selectedFromQuery = useMemo(() => {
    const params = new URLSearchParams(location.search);
    return normalizeCampaignId(params.get('campaign'));
  }, [location.search]);

  useEffect(() => {
    selectedCampaignIdRef.current = normalizeCampaignId(selectedCampaignId);
  }, [selectedCampaignId]);

  useEffect(() => {
    if (selectedFromQuery) {
      setSelectedCampaignId(selectedFromQuery);
      selectedCampaignIdRef.current = selectedFromQuery;
      writeStoredSelectedCampaignId(appUser, selectedFromQuery);
      return;
    }

    const storedCampaignId = normalizeCampaignId(readStoredSelectedCampaignId(appUser));
    setSelectedCampaignId(storedCampaignId);
    selectedCampaignIdRef.current = storedCampaignId;
  }, [appUser?.email, selectedFromQuery]);

  const loadRecipients = useCallback(async (campaignId, page = 1) => {
    const normalizedCampaignId = normalizeCampaignId(campaignId);
    if (!normalizedCampaignId) {
      return;
    }

    const requestId = recipientsRequestRef.current + 1;
    recipientsRequestRef.current = requestId;

    const data = await fetchJson(
      `/api/campaigns/${normalizedCampaignId}/recipients?page=${page}&limit=${RECIPIENTS_PAGE_SIZE}`
    );
    if (requestId !== recipientsRequestRef.current) {
      return;
    }

    setSelectedCampaignId(normalizedCampaignId);
    selectedCampaignIdRef.current = normalizedCampaignId;
    writeStoredSelectedCampaignId(appUser, normalizedCampaignId);
    setSelectedCampaign(data.campaign);
    setRecipients(data.recipients || []);
    setRecipientPagination({
      page: Number(data.pagination?.page || 1),
      limit: Number(data.pagination?.limit || RECIPIENTS_PAGE_SIZE),
      total: Number(data.pagination?.total || 0),
      totalPages: Number(data.pagination?.totalPages || 1),
      hasNextPage: Boolean(data.pagination?.hasNextPage),
      hasPreviousPage: Boolean(data.pagination?.hasPreviousPage)
    });
  }, [appUser?.email]);

  const loadDashboard = useCallback(async () => {
    try {
      const [authData, campaignData] = await Promise.all([fetchJson('/api/auth/status'), fetchJson('/api/campaigns')]);

      const nextCampaigns = campaignData.campaigns || [];
      setAuth(authData);
      setCampaigns(nextCampaigns);

      const storedCampaignId = normalizeCampaignId(readStoredSelectedCampaignId(appUser));
      const currentSelectedCampaignId = selectedCampaignIdRef.current;
      const preferredCampaignId =
        currentSelectedCampaignId || selectedFromQuery || storedCampaignId || normalizeCampaignId(nextCampaigns[0]?.id);

      if (!preferredCampaignId) {
        setSelectedCampaignId(null);
        selectedCampaignIdRef.current = null;
        setSelectedCampaign(null);
        setRecipients([]);
        writeStoredSelectedCampaignId(appUser, '');
        setRecipientPagination({
          page: 1,
          limit: RECIPIENTS_PAGE_SIZE,
          total: 0,
          totalPages: 1,
          hasNextPage: false,
          hasPreviousPage: false
        });
        return;
      }

      const stillExists = nextCampaigns.some((campaign) => normalizeCampaignId(campaign.id) === preferredCampaignId);
      if (stillExists) {
        const nextPage = preferredCampaignId === currentSelectedCampaignId ? recipientPagination.page || 1 : 1;
        await loadRecipients(preferredCampaignId, nextPage);
        return;
      }

      const fallbackCampaignId = normalizeCampaignId(nextCampaigns[0]?.id);
      if (fallbackCampaignId) {
        await loadRecipients(fallbackCampaignId, 1);
      } else {
        setSelectedCampaignId(null);
        selectedCampaignIdRef.current = null;
        setSelectedCampaign(null);
        setRecipients([]);
        writeStoredSelectedCampaignId(appUser, '');
        setRecipientPagination({
          page: 1,
          limit: RECIPIENTS_PAGE_SIZE,
          total: 0,
          totalPages: 1,
          hasNextPage: false,
          hasPreviousPage: false
        });
      }
    } catch (error) {
      setNotice({ type: 'error', message: error.message });
    }
  }, [appUser?.email, loadRecipients, recipientPagination.page, selectedFromQuery]);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (params.get('sent') || params.get('generated')) {
      setNotice({ type: 'success', message: 'Campaign queued. Tracking has started.' });
    }
  }, [location.search]);

  useEffect(() => {
    loadDashboard();
  }, [loadDashboard]);

  useEffect(() => {
    const timer = setInterval(() => {
      loadDashboard();
    }, 15000);

    return () => clearInterval(timer);
  }, [loadDashboard]);

  const selectedCampaignMetrics = useMemo(() => {
    const normalizedSelectedCampaignId = normalizeCampaignId(selectedCampaignId);
    if (!normalizedSelectedCampaignId) {
      return null;
    }

    return campaigns.find((campaign) => normalizeCampaignId(campaign.id) === normalizedSelectedCampaignId) || null;
  }, [campaigns, selectedCampaignId]);

  const selectedCampaignSummary = selectedCampaignMetrics || selectedCampaign;
  const campaignScopeDescription = appUser?.isAdmin
    ? 'All campaign runs with sending and open-tracking status.'
    : 'Campaign runs created under this login account.';
  const selectedCampaignDetails = useMemo(() => {
    if (!selectedCampaignSummary) {
      return [];
    }

    return [
      { label: 'Campaign Name', value: selectedCampaignSummary.name || '-' },
      { label: 'Status', value: selectedCampaignSummary.status || '-' },
      {
        label: 'Sender Account',
        value: selectedCampaignSummary.account_email
          ? `${selectedCampaignSummary.account_email} (${String(selectedCampaignSummary.account_type || 'google').toUpperCase()})`
          : '-'
      },
      { label: 'Created At', value: formatDateTime(selectedCampaignSummary.created_at) },
      { label: 'Scheduled At', value: formatDateTime(selectedCampaignSummary.scheduled_at) },
      { label: 'Recipients', value: Number(selectedCampaignSummary.total_recipients || 0) },
      { label: 'Sent', value: Number(selectedCampaignSummary.sent_count || 0) },
      { label: 'Opened', value: Number(selectedCampaignSummary.opened_count || 0) },
      { label: 'Failed', value: Number(selectedCampaignSummary.failed_count || 0) }
    ];
  }, [selectedCampaignSummary]);

  const kpis = useMemo(() => {
    if (selectedCampaignMetrics) {
      const campaignRecipients = Number(selectedCampaignMetrics.total_recipients || 0);
      const campaignSent = Number(selectedCampaignMetrics.sent_count || 0);
      const campaignOpened = Number(selectedCampaignMetrics.opened_count || 0);
      const campaignOpenRate = campaignSent > 0 ? ((campaignOpened / campaignSent) * 100).toFixed(1) : '0.0';

      return {
        scope: `Metrics for campaign: ${selectedCampaignMetrics.name}`,
        cards: [
          { title: 'Campaign Recipients', value: campaignRecipients },
          { title: 'Campaign Sent', value: campaignSent },
          { title: 'Campaign Opened', value: campaignOpened },
          { title: 'Campaign Open Rate', value: `${campaignOpenRate}%` }
        ]
      };
    }

    const totalCampaigns = campaigns.length;
    const totalSent = campaigns.reduce((sum, campaign) => sum + Number(campaign.sent_count || 0), 0);
    const totalOpened = campaigns.reduce((sum, campaign) => sum + Number(campaign.opened_count || 0), 0);
    const openRate = totalSent > 0 ? ((totalOpened / totalSent) * 100).toFixed(1) : '0.0';

    return {
      scope: 'Metrics for visible campaigns',
      cards: [
        { title: 'Total Campaigns', value: totalCampaigns },
        { title: 'Total Sent', value: totalSent },
        { title: 'Total Opened', value: totalOpened },
        { title: 'Open Rate', value: `${openRate}%` }
      ]
    };
  }, [campaigns, selectedCampaignMetrics]);

  async function handleSendNow(campaignId) {
    const normalizedCampaignId = normalizeCampaignId(campaignId);
    if (!normalizedCampaignId) {
      return;
    }

    try {
      await fetchJson(`/api/campaigns/${normalizedCampaignId}/send-now`, { method: 'POST' });
      setNotice({ type: 'success', message: 'Campaign queued for immediate send.' });
      await loadDashboard();
    } catch (error) {
      setNotice({ type: 'error', message: error.message });
    }
  }

  async function handleCampaignSelect(campaignId) {
    const normalizedCampaignId = normalizeCampaignId(campaignId);
    if (!normalizedCampaignId) {
      return;
    }

    setSelectedCampaignId(normalizedCampaignId);
    selectedCampaignIdRef.current = normalizedCampaignId;
    writeStoredSelectedCampaignId(appUser, normalizedCampaignId);
    try {
      await loadRecipients(normalizedCampaignId, 1);
    } catch (error) {
      setNotice({ type: 'error', message: error.message });
    }
  }

  async function handleRecipientsPageChange(nextPage) {
    if (!selectedCampaignId) {
      return;
    }

    try {
      await loadRecipients(selectedCampaignId, nextPage);
    } catch (error) {
      setNotice({ type: 'error', message: error.message });
    }
  }

  function getOpenStatus(recipient) {
    if (recipient.status === 'OPENED' || recipient.opened_at) {
      return 'Opened';
    }

    if (recipient.status === 'SENT') {
      return 'Not Opened';
    }

    if (recipient.status === 'FAILED') {
      return 'Send Failed';
    }

    return 'Not Sent';
  }

  function openStatusBadgeClass(recipient) {
    const label = getOpenStatus(recipient);
    if (label === 'Opened') {
      return 'badge badge-opened';
    }

    if (label === 'Not Opened') {
      return 'badge badge-not-opened';
    }

    if (label === 'Send Failed') {
      return 'badge badge-failed';
    }

    return 'badge badge-pending';
  }

  function parseFilenameFromDisposition(disposition) {
    const match = String(disposition || '').match(/filename\*?=(?:UTF-8''|")?([^\";]+)/i);
    if (!match || !match[1]) {
      return '';
    }

    const value = match[1].replace(/"/g, '').trim();
    try {
      return decodeURIComponent(value);
    } catch (_error) {
      return value;
    }
  }

  async function handleRecipientsExport() {
    if (!selectedCampaignId) {
      return;
    }

    try {
      setIsExporting(true);
      const response = await fetch(resolveApiUrl(`/api/campaigns/${selectedCampaignId}/recipients/export.xlsx?openedOnly=1`), {
        headers: withAuthHeaders()
      });

      if (!response.ok) {
        const contentType = response.headers.get('content-type') || '';
        let errorMessage = '';

        if (contentType.includes('application/json')) {
          const payload = await response.json().catch(() => null);
          errorMessage = payload?.error || '';
        } else {
          errorMessage = await response.text().catch(() => '');
        }

        throw new Error(errorMessage || 'Failed to export opened recipients.');
      }

      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      const fileNameFromHeader = parseFilenameFromDisposition(response.headers.get('content-disposition'));
      const fallbackFileName = `${selectedCampaignId}-opened-recipients.xlsx`;

      anchor.href = objectUrl;
      anchor.download = fileNameFromHeader || fallbackFileName;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(objectUrl);
    } catch (error) {
      setNotice({ type: 'error', message: error.message });
    } finally {
      setIsExporting(false);
    }
  }

  const accountBadgeClass = auth.connected && auth.activeAccount ? 'badge badge-low' : 'badge badge-high';
  const accountProvider = String(auth.activeAccountDetails?.provider || '').toUpperCase();
  const accountLabel =
    auth.connected && auth.activeAccount
      ? accountProvider
        ? `${auth.activeAccount} (${accountProvider})`
        : auth.activeAccount
      : 'No account connected';

  return (
    <AppLayout
      caption="Track send performance, email opens, and recipient-level delivery status in real time."
      user={appUser}
      onLogout={onLogout}
    >
      <header className="page-header">
        <div>
          <h1 className="page-title">Campaign Dashboard</h1>
          <div className="page-subtitle">
            {appUser?.isAdmin
              ? 'Admin view: campaigns from all users and recipient open-status events.'
              : 'Your view: campaigns created from your login and recipient open-status events.'}
          </div>
        </div>
        <div className="inline-actions no-top-margin">
          <div className={accountBadgeClass}>{accountLabel}</div>
          <button className="btn btn-secondary" onClick={loadDashboard} type="button">
            Refresh
          </button>
        </div>
      </header>

      <section className="kpi-grid">
        {kpis.cards.map((card) => (
          <div className="kpi" key={card.title}>
            <div className="kpi-title">{card.title}</div>
            <div className="kpi-value">{card.value}</div>
          </div>
        ))}
      </section>
      <small className="muted">{kpis.scope}</small>
      {selectedCampaignSummary && (
        <section className="card section-gap">
          <h3>Selected Campaign Details</h3>
          <div className="campaign-detail-grid space-top-small">
            {selectedCampaignDetails.map((item) => (
              <div className="campaign-detail-item" key={item.label}>
                <div className="campaign-detail-label">{item.label}</div>
                <div className="campaign-detail-value">{item.value}</div>
              </div>
            ))}
          </div>
          <div className="space-top-small">
            <div className="campaign-detail-label">Subject</div>
            <div className="notice">{selectedCampaignSummary.subject || '-'}</div>
          </div>
        </section>
      )}

      <section className="split section-gap">
        <div className="card">
          <h3>Campaigns</h3>
          <p>{campaignScopeDescription}</p>

          <div className="table-wrap space-top-small">
            <table className="responsive-table campaigns-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Status</th>
                  <th>Scheduled</th>
                  <th>Sent</th>
                  <th>Opened</th>
                  <th>Failed</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {!campaigns.length && (
                  <tr>
                    <td colSpan="7">No campaigns found.</td>
                  </tr>
                )}

                {campaigns.map((campaign) => {
                  const canSendNow = ['SCHEDULED', 'QUEUED', 'FAILED', 'PARTIAL'].includes(campaign.status);
                  const campaignId = normalizeCampaignId(campaign.id);
                  if (!campaignId) {
                    return null;
                  }

                  return (
                    <tr
                      key={campaignId}
                      className={`table-row-clickable${selectedCampaignId === campaignId ? ' table-row-selected' : ''}`}
                      onClick={() => handleCampaignSelect(campaignId)}
                    >
                      <td data-label="Name">
                        <button
                          className="table-link"
                          onClick={(event) => {
                            event.stopPropagation();
                            handleCampaignSelect(campaignId);
                          }}
                          type="button"
                        >
                          {campaign.name}
                        </button>
                      </td>
                      <td data-label="Status">
                        <span className={statusBadgeClass(campaign.status)}>{campaign.status}</span>
                      </td>
                      <td data-label="Scheduled">{formatDateTime(campaign.scheduled_at || campaign.created_at)}</td>
                      <td data-label="Sent">
                        {Number(campaign.sent_count || 0)}/{Number(campaign.total_recipients || 0)}
                      </td>
                      <td data-label="Opened">{Number(campaign.opened_count || 0)}</td>
                      <td data-label="Failed">{Number(campaign.failed_count || 0)}</td>
                      <td data-label="Actions">
                        {canSendNow ? (
                          <button
                            className="btn btn-warning"
                            onClick={(event) => {
                              event.stopPropagation();
                              handleSendNow(campaignId);
                            }}
                            type="button"
                          >
                            Send Now
                          </button>
                        ) : (
                          '-'
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <Notice notice={notice} />
        </div>

        <div className="card">
          <h3>{selectedCampaignSummary ? `Recipients · ${selectedCampaignSummary.name}` : 'Recipients'}</h3>
          <p>
            {selectedCampaignSummary
              ? `Showing ${recipients.length} of ${recipientPagination.total} recipients (page ${recipientPagination.page}/${recipientPagination.totalPages}).`
              : 'Select a campaign to inspect recipient-level delivery/open status.'}
          </p>
          {selectedCampaignSummary && (
            <div className="inline-actions space-top-small">
              <button className="btn btn-secondary" onClick={handleRecipientsExport} type="button" disabled={isExporting}>
                {isExporting ? 'Preparing Excel...' : 'Download Opened Recipients (.xlsx)'}
              </button>
              <button
                className="btn btn-secondary"
                type="button"
                onClick={() => handleRecipientsPageChange(recipientPagination.page - 1)}
                disabled={!recipientPagination.hasPreviousPage}
              >
                Previous Page
              </button>
              <button
                className="btn btn-secondary"
                type="button"
                onClick={() => handleRecipientsPageChange(recipientPagination.page + 1)}
                disabled={!recipientPagination.hasNextPage}
              >
                Next Page
              </button>
            </div>
          )}

          <div className="table-wrap space-top-small">
            <table className="responsive-table recipients-table">
              <thead>
                <tr>
                  <th>Email</th>
                  <th>Delivery</th>
                  <th>Open Status</th>
                  <th>Sent At</th>
                  <th>Opened At</th>
                  <th>Open Count</th>
                </tr>
              </thead>
              <tbody>
                {!selectedCampaignSummary && (
                  <tr>
                    <td colSpan="6">No campaign selected.</td>
                  </tr>
                )}

                {selectedCampaignSummary && !recipients.length && (
                  <tr>
                    <td colSpan="6">No recipients in this campaign.</td>
                  </tr>
                )}

                {recipients.map((recipient) => (
                  <tr key={recipient.id}>
                    <td data-label="Email">{recipient.email}</td>
                    <td data-label="Delivery">
                      <span className={statusBadgeClass(recipient.status)}>{recipient.status}</span>
                    </td>
                    <td data-label="Open Status">
                      <span className={openStatusBadgeClass(recipient)}>{getOpenStatus(recipient)}</span>
                    </td>
                    <td data-label="Sent At">{formatDateTime(recipient.sent_at)}</td>
                    <td data-label="Opened At">{formatDateTime(recipient.opened_at)}</td>
                    <td data-label="Open Count">{Number(recipient.open_count || 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </AppLayout>
  );
}
