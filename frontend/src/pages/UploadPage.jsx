import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import AppLayout from '../components/AppLayout';
import { fetchJson } from '../lib/api';

function Notice({ notice }) {
  if (!notice) {
    return null;
  }

  const className = notice.type === 'error' ? 'notice error' : notice.type === 'success' ? 'notice success' : 'notice';
  return <div className={className}>{notice.message}</div>;
}

export default function UploadPage({ flow, onRecipientsReady }) {
  const navigate = useNavigate();
  const [auth, setAuth] = useState({
    connected: false,
    activeAccount: null,
    activeAccountDetails: null,
    accounts: [],
    hasGoogleConfig: true,
    hasMicrosoftConfig: false
  });
  const [preview, setPreview] = useState(flow.preview || null);
  const [isReading, setIsReading] = useState(false);
  const [uploadNotice, setUploadNotice] = useState(null);
  const [connectionNotice, setConnectionNotice] = useState(null);
  const [smtp, setSmtp] = useState({
    email: '',
    password: '',
    fromName: ''
  });
  const [smtpConnecting, setSmtpConnecting] = useState(false);

  const loadAuth = useCallback(async () => {
    const data = await fetchJson('/api/auth/status');
    setAuth(data);

    if (data.databaseUnavailable) {
      setConnectionNotice({ type: 'error', message: 'Database unavailable. Start MongoDB and retry.' });
    }
  }, []);

  useEffect(() => {
    setPreview(flow.preview || null);
  }, [flow.preview]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const connected = params.get('connected');
    const connectedProvider = String(params.get('connected_provider') || 'google').toLowerCase();
    const oauthProvider = String(params.get('oauth_provider') || '').toLowerCase();
    const oauthError = params.get('oauth_error');

    if (connected) {
      const providerLabel = connectedProvider === 'microsoft' ? 'Microsoft' : 'Google';
      setConnectionNotice({ type: 'success', message: `${providerLabel} account connected: ${connected}` });
    }

    if (oauthError) {
      const providerLabel = oauthProvider === 'microsoft' ? 'Microsoft' : oauthProvider === 'google' ? 'Google' : 'OAuth';
      setConnectionNotice({ type: 'error', message: `${providerLabel} OAuth failed: ${oauthError}` });
    }

    loadAuth().catch((error) => {
      setConnectionNotice({ type: 'error', message: error.message });
    });
  }, [loadAuth]);

  const recipientSummary = useMemo(() => {
    if (!preview) {
      return null;
    }

    return `${preview.total} recipients ready for campaign setup`;
  }, [preview]);

  const activeAccountBadge = useMemo(() => {
    if (auth.connected && auth.activeAccount) {
      const provider = String(auth.activeAccountDetails?.provider || '').toUpperCase();
      return {
        className: 'badge badge-low',
        text: provider ? `Connected: ${auth.activeAccount} (${provider})` : `Connected: ${auth.activeAccount}`
      };
    }

    return {
      className: 'badge badge-medium',
      text: 'Connect sender account first'
    };
  }, [auth.connected, auth.activeAccount, auth.activeAccountDetails]);

  async function handleConnectGoogle() {
    setConnectionNotice(null);

    try {
      const senderEmail = String(smtp.email || '').trim();
      const endpoint = senderEmail ? `/api/auth/google/url?senderEmail=${encodeURIComponent(senderEmail)}` : '/api/auth/google/url';
      const response = await fetchJson(endpoint);
      window.location.href = response.url;
    } catch (error) {
      setConnectionNotice({ type: 'error', message: error.message });
    }
  }

  async function handleConnectMicrosoft() {
    setConnectionNotice(null);

    try {
      const response = await fetchJson('/api/auth/microsoft/url');
      window.location.href = response.url;
    } catch (error) {
      setConnectionNotice({ type: 'error', message: error.message });
    }
  }

  function handleSmtpFieldChange(field, value) {
    setSmtp((current) => ({
      ...current,
      [field]: value
    }));
  }

  async function handleConnectSmtpAccount() {
    setConnectionNotice(null);
    setSmtpConnecting(true);

    try {
      const payload = {
        email: String(smtp.email || '').trim(),
        password: String(smtp.password || ''),
        fromName: String(smtp.fromName || '').trim()
      };

      const response = await fetchJson('/api/auth/smtp/connect', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      await loadAuth();
      setConnectionNotice({
        type: 'success',
        message: `Account verified and connected: ${response.account?.email || payload.email}`
      });
      setSmtp((current) => ({
        ...current,
        password: ''
      }));
    } catch (error) {
      const message = String(error?.message || '');
      const lowerMessage = message.toLowerCase();
      const shouldRedirectMicrosoft =
        auth.hasMicrosoftConfig &&
        (lowerMessage.includes('smtp auth disabled') ||
          lowerMessage.includes('smtpclientauthentication is disabled') ||
          lowerMessage.includes('connect microsoft account'));
      const shouldRedirectGoogle =
        auth.hasGoogleConfig &&
        (lowerMessage.includes('google-hosted') ||
          lowerMessage.includes('google workspace mailbox') ||
          lowerMessage.includes('use connect google account'));

      if (shouldRedirectMicrosoft) {
        try {
          setConnectionNotice({
            type: 'notice',
            message: `${message} Redirecting to Microsoft sign-in...`
          });
          const oauth = await fetchJson('/api/auth/microsoft/url');
          window.location.href = oauth.url;
          return;
        } catch (oauthError) {
          setConnectionNotice({ type: 'error', message: oauthError.message });
          return;
        }
      }

      if (shouldRedirectGoogle) {
        try {
          const senderEmail = String(smtp.email || '').trim();
          const endpoint = senderEmail ? `/api/auth/google/url?senderEmail=${encodeURIComponent(senderEmail)}` : '/api/auth/google/url';
          setConnectionNotice({
            type: 'notice',
            message: `${message} Redirecting to Google sign-in...`
          });
          const oauth = await fetchJson(endpoint);
          window.location.href = oauth.url;
          return;
        } catch (oauthError) {
          setConnectionNotice({ type: 'error', message: oauthError.message });
          return;
        }
      }

      setConnectionNotice({ type: 'error', message });
    } finally {
      setSmtpConnecting(false);
    }
  }

  async function handleDisconnectAccount() {
    setConnectionNotice(null);

    try {
      const response = await fetchJson('/api/auth/disconnect', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ email: auth.activeAccount || '' })
      });

      await loadAuth();
      setPreview(null);
      onRecipientsReady(null, null);

      if (response.disconnected) {
        setConnectionNotice({
          type: 'success',
          message: `Disconnected account: ${response.disconnectedEmail}`
        });
      } else {
        setConnectionNotice({
          type: 'error',
          message: 'No account was disconnected.'
        });
      }
    } catch (error) {
      setConnectionNotice({ type: 'error', message: error.message });
    }
  }

  async function handleAccountChange(event) {
    const email = event.target.value;
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
      setConnectionNotice({ type: 'success', message: `Active account changed to ${email}` });
    } catch (error) {
      setConnectionNotice({ type: 'error', message: error.message });
    }
  }

  async function handleExcelSelect(event) {
    const file = event.target.files?.[0] || null;
    setUploadNotice(null);

    if (!auth.connected) {
      setUploadNotice({ type: 'error', message: 'Connect a sender account first, then upload Excel.' });
      onRecipientsReady(null, null);
      setPreview(null);
      return;
    }

    if (!file) {
      setPreview(null);
      onRecipientsReady(null, null);
      return;
    }

    setIsReading(true);

    try {
      const formData = new FormData();
      formData.append('excelFile', file);

      const data = await fetchJson('/api/recipients/preview', {
        method: 'POST',
        body: formData
      });

      setPreview(data);
      onRecipientsReady(file, data);
      setUploadNotice({ type: 'success', message: `Sheet parsed successfully: ${data.total} recipients found.` });
    } catch (error) {
      setUploadNotice({ type: 'error', message: error.message });
      setPreview(null);
      onRecipientsReady(null, null);
    } finally {
      setIsReading(false);
    }
  }

  function handleContinue() {
    navigate('/compose');
  }

  return (
    <AppLayout caption="Step 1: Connect sender account (Google or SMTP credentials). Step 2: Upload Excel recipients. Step 3: Build template and send campaign.">
      <header className="page-header">
        <div>
          <h1 className="page-title">Connect Sender & Upload Recipients</h1>
          <div className="page-subtitle">Connect Google/Microsoft or verify SMTP email credentials, then upload recipient Excel sheet.</div>
        </div>
        <div className={activeAccountBadge.className}>{activeAccountBadge.text}</div>
      </header>

      <section className="split">
        <div className="grid">
          <div className="card">
            <div className="step">
              <span className="step-index">1</span>Connect Sender Account
            </div>
            <p>Connect sender account before proceeding to upload.</p>

            <label htmlFor="uploadAccountSelect">Connected Sender Account</label>
            <select id="uploadAccountSelect" value={auth.activeAccount || ''} onChange={handleAccountChange}>
              {!auth.accounts?.length && <option value="">No account connected yet</option>}
              {auth.accounts?.map((account) => (
                <option key={`${account.provider || 'google'}:${account.email}`} value={account.email}>
                  {account.email} ({String(account.provider || 'google').toUpperCase()})
                </option>
              ))}
            </select>

            <div className="inline-actions">
              <button className="btn btn-primary" type="button" onClick={handleConnectGoogle}>
                {auth.accounts?.length ? 'Connect Another Google Account' : 'Connect Google Account'}
              </button>
              <button className="btn btn-secondary" type="button" onClick={handleConnectMicrosoft}>
                Connect Microsoft Account
              </button>
              <button
                className="btn btn-danger"
                type="button"
                onClick={handleDisconnectAccount}
                disabled={!auth.connected}
              >
                Disconnect Account
              </button>
            </div>
            <small className="muted">You can connect multiple sender emails and switch sender from the dropdown.</small>

            <div className="notice space-top">
              <div className="step">
                <span className="step-index">SMTP</span>Verify Organization/Other Email (Password Sign-In)
              </div>

              <div className="grid grid-2 space-top-small">
                <div>
                  <label htmlFor="smtpEmailUpload">Sender Email</label>
                  <input
                    id="smtpEmailUpload"
                    type="email"
                    value={smtp.email}
                    onChange={(event) => handleSmtpFieldChange('email', event.target.value)}
                    placeholder="you@domain.com"
                  />
                </div>
                <div>
                  <label htmlFor="smtpFromNameUpload">From Name (optional)</label>
                  <input
                    id="smtpFromNameUpload"
                    type="text"
                    value={smtp.fromName}
                    onChange={(event) => handleSmtpFieldChange('fromName', event.target.value)}
                    placeholder="Your Name"
                  />
                </div>
              </div>

              <div className="space-top-small">
                <label htmlFor="smtpPasswordUpload">Password / App Password</label>
                <input
                  id="smtpPasswordUpload"
                  type="password"
                  value={smtp.password}
                  onChange={(event) => handleSmtpFieldChange('password', event.target.value)}
                  placeholder="Enter password"
                />
              </div>

              <div className="inline-actions">
                <button className="btn btn-secondary" type="button" onClick={handleConnectSmtpAccount} disabled={smtpConnecting}>
                  {smtpConnecting ? 'Verifying...' : 'Connect Other Email'}
                </button>
              </div>
              <small className="muted">This verifies credentials directly and connects the sender account in this app.</small>
            </div>

            {!auth.hasGoogleConfig && (
              <Notice
                notice={{
                  type: 'notice',
                  message: 'Google OAuth is not configured. Use SMTP verification above or set GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET/GOOGLE_REDIRECT_URI in backend/.env.'
                }}
              />
            )}
            {!auth.hasMicrosoftConfig && (
              <Notice
                notice={{
                  type: 'notice',
                  message:
                    'Microsoft OAuth is not configured. Set MICROSOFT_CLIENT_ID and MICROSOFT_REDIRECT_URI (optionally MICROSOFT_CLIENT_SECRET, MICROSOFT_TENANT_ID) in backend/.env.'
                }}
              />
            )}

            <Notice notice={connectionNotice} />
          </div>

          <div className="card">
            <div className="step">
              <span className="step-index">2</span>Upload Excel Sheet
            </div>
            <p>Upload your Excel file containing recipient emails.</p>

            {!auth.connected && <div className="notice">Connect sender account to unlock upload step.</div>}

            <div className="space-top">
              <label htmlFor="excelFileUpload">Recipients File (.xlsx / .xls)</label>
              <input
                id="excelFileUpload"
                type="file"
                accept=".xlsx,.xls"
                onChange={handleExcelSelect}
                disabled={!auth.connected || isReading}
              />
              <small className="muted">All email addresses in all sheets are detected automatically.</small>
            </div>

            <div className="inline-actions space-top">
              <button
                className="btn btn-primary"
                type="button"
                disabled={!preview || isReading || !auth.connected}
                onClick={handleContinue}
              >
                Continue To Template
              </button>
            </div>

            <Notice notice={uploadNotice} />
          </div>

          <div className="card">
            <h3>What Happens Next</h3>
            <p>
              In template builder, enter subject, body, signature, and check the OpenAI subject spam meter, then send the
              campaign. App automatically moves you to tracking dashboard.
            </p>
            {recipientSummary && <div className="notice success">{recipientSummary}</div>}
          </div>
        </div>

        <div className="grid">
          <div className="card">
            <h3>Detected Recipients</h3>
            <p>Preview extracted emails before moving forward.</p>

            {!preview && <div className="notice">No file processed yet.</div>}

            {preview && (
              <>
                <div className="notice success">Total: {preview.total}</div>
                <div className="preview-list">
                  {preview.emails.map((email) => (
                    <div className="preview-item" key={email}>
                      {email}
                    </div>
                  ))}
                  {preview.total > preview.emails.length && (
                    <div className="preview-item">...and {preview.total - preview.emails.length} more</div>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </section>
    </AppLayout>
  );
}
