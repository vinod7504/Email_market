import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import AppLayout from '../components/AppLayout';
import { fetchJson, formatDateTime } from '../lib/api';

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

export default function DashboardPage() {
  const location = useLocation();
  const [auth, setAuth] = useState({ connected: false, activeAccount: null, activeAccountDetails: null });
  const [campaigns, setCampaigns] = useState([]);
  const [selectedCampaignId, setSelectedCampaignId] = useState(null);
  const [selectedCampaign, setSelectedCampaign] = useState(null);
  const [recipients, setRecipients] = useState([]);
  const [isExporting, setIsExporting] = useState(false);
  const [notice, setNotice] = useState(null);
  const selectedFromQuery = useMemo(() => {
    const params = new URLSearchParams(location.search);
    return params.get('campaign');
  }, [location.search]);

  const loadRecipients = useCallback(async (campaignId) => {
    const data = await fetchJson(`/api/campaigns/${campaignId}/recipients`);
    setSelectedCampaignId(campaignId);
    setSelectedCampaign(data.campaign);
    setRecipients(data.recipients || []);
  }, []);

  const loadDashboard = useCallback(async () => {
    try {
      const [authData, campaignData] = await Promise.all([fetchJson('/api/auth/status'), fetchJson('/api/campaigns')]);

      const nextCampaigns = campaignData.campaigns || [];
      setAuth(authData);
      setCampaigns(nextCampaigns);

      const targetCampaignId = selectedCampaignId || selectedFromQuery;
      if (targetCampaignId) {
        const stillExists = nextCampaigns.some((campaign) => campaign.id === targetCampaignId);
        if (stillExists) {
          await loadRecipients(targetCampaignId);
        } else {
          setSelectedCampaignId(null);
          setSelectedCampaign(null);
          setRecipients([]);
        }
      }
    } catch (error) {
      setNotice({ type: 'error', message: error.message });
    }
  }, [loadRecipients, selectedCampaignId, selectedFromQuery]);

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
    if (!selectedCampaignId) {
      return null;
    }

    return campaigns.find((campaign) => campaign.id === selectedCampaignId) || null;
  }, [campaigns, selectedCampaignId]);

  const selectedCampaignSummary = selectedCampaignMetrics || selectedCampaign;

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
      scope: 'Metrics for all campaigns',
      cards: [
        { title: 'Total Campaigns', value: totalCampaigns },
        { title: 'Total Sent', value: totalSent },
        { title: 'Total Opened', value: totalOpened },
        { title: 'Open Rate', value: `${openRate}%` }
      ]
    };
  }, [campaigns, selectedCampaignMetrics]);

  async function handleSendNow(campaignId) {
    try {
      await fetchJson(`/api/campaigns/${campaignId}/send-now`, { method: 'POST' });
      setNotice({ type: 'success', message: 'Campaign queued for immediate send.' });
      await loadDashboard();
    } catch (error) {
      setNotice({ type: 'error', message: error.message });
    }
  }

  async function handleCampaignSelect(campaignId) {
    try {
      await loadRecipients(campaignId);
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
      const response = await fetch(`/api/campaigns/${selectedCampaignId}/recipients/export.xlsx?openedOnly=1`);

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
    <AppLayout caption="Track send performance, email opens, and recipient-level delivery status in real time.">
      <header className="page-header">
        <div>
          <h1 className="page-title">Campaign Dashboard</h1>
          <div className="page-subtitle">View all sent campaigns and recipient open-status events.</div>
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

      <section className="split section-gap">
        <div className="card">
          <h3>Campaigns</h3>
          <p>All campaign runs with sending and open-tracking status.</p>

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
                  return (
                    <tr
                      key={campaign.id}
                      className={`table-row-clickable${selectedCampaignId === campaign.id ? ' table-row-selected' : ''}`}
                      onClick={() => handleCampaignSelect(campaign.id)}
                    >
                      <td data-label="Name">
                        <button
                          className="table-link"
                          onClick={(event) => {
                            event.stopPropagation();
                            handleCampaignSelect(campaign.id);
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
                              handleSendNow(campaign.id);
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
              ? `${recipients.length} recipients in this campaign.`
              : 'Select a campaign to inspect recipient-level delivery/open status.'}
          </p>
          {selectedCampaignSummary && (
            <div className="inline-actions space-top-small">
              <button className="btn btn-secondary" onClick={handleRecipientsExport} type="button" disabled={isExporting}>
                {isExporting ? 'Preparing Excel...' : 'Download Opened Recipients (.xlsx)'}
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
