import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import AppLayout from '../components/AppLayout';
import { fetchJson } from '../lib/api';

const EMPTY_SPAM = {
  score: 0,
  label: 'Low',
  reasons: ['Start typing subject/body to calculate spam risk.'],
  improvements: ['Keep content clear and simple.'],
  source: 'heuristic'
};

function Notice({ notice }) {
  if (!notice) {
    return null;
  }

  const className = notice.type === 'error' ? 'notice error' : notice.type === 'success' ? 'notice success' : 'notice';
  return <div className={className}>{notice.message}</div>;
}

function spamBadgeClass(label) {
  const key = String(label || '').toLowerCase();
  if (key === 'high') {
    return 'badge badge-high';
  }

  if (key === 'medium') {
    return 'badge badge-medium';
  }

  return 'badge badge-low';
}

function composeEmailBody(body, signature) {
  const trimmedBody = String(body || '').trim();
  const trimmedSignature = String(signature || '').trim();

  if (!trimmedSignature) {
    return trimmedBody;
  }

  if (trimmedBody.includes(trimmedSignature)) {
    return trimmedBody;
  }

  return [trimmedBody, trimmedSignature].filter(Boolean).join('\n\n');
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function trimTrailingPunctuation(url) {
  let clean = String(url || '');
  let trailing = '';

  while (/[),.!?;:'"]$/.test(clean)) {
    trailing = clean.slice(-1) + trailing;
    clean = clean.slice(0, -1);
  }

  return { clean, trailing };
}

function isImageUrl(url) {
  return /\.(png|jpe?g|gif|webp|svg)(\?.*)?(#.*)?$/i.test(String(url || '').trim());
}

function containsHtmlMarkup(value) {
  return /<\/?[a-z][^>]*>/i.test(String(value || ''));
}

function sanitizeHtmlMarkup(value) {
  return String(value || '')
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, '')
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, '')
    .replace(/\son\w+\s*=\s*'[^']*'/gi, '')
    .replace(/\son\w+\s*=\s*[^\s>]+/gi, '')
    .replace(/(href|src)\s*=\s*(['"])\s*javascript:[\s\S]*?\2/gi, '$1="#"');
}

function renderPreviewMarkup(value) {
  const raw = String(value || '');
  if (!raw.trim()) {
    return '';
  }

  if (containsHtmlMarkup(raw)) {
    return sanitizeHtmlMarkup(raw);
  }

  const urlPattern = /https?:\/\/[^\s<>"']+/gi;
  let html = '';
  let cursor = 0;

  for (const match of raw.matchAll(urlPattern)) {
    const fullUrl = match[0];
    const start = Number(match.index || 0);
    html += escapeHtml(raw.slice(cursor, start));

    const { clean, trailing } = trimTrailingPunctuation(fullUrl);
    if (clean) {
      const safeUrl = escapeHtml(clean);
      html += `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer">${safeUrl}</a>`;
      if (isImageUrl(clean)) {
        html += `<br/><img src="${safeUrl}" alt="" />`;
      }
    }

    html += escapeHtml(trailing);
    cursor = start + fullUrl.length;
  }

  html += escapeHtml(raw.slice(cursor));
  return html.replace(/\n/g, '<br/>');
}

export default function ComposePage({ flow, onRecipientsReady }) {
  const navigate = useNavigate();

  const [auth, setAuth] = useState({
    connected: false,
    activeAccount: null,
    activeAccountDetails: null,
    accounts: [],
    hasGoogleConfig: true,
    hasMicrosoftConfig: false
  });
  const [composeNotice, setComposeNotice] = useState(null);
  const [connectionNotice, setConnectionNotice] = useState(null);
  const [publicBaseUrl, setPublicBaseUrl] = useState('');
  const [campaignName, setCampaignName] = useState('');
  const [subjectText, setSubjectText] = useState('');
  const [bodyText, setBodyText] = useState('');
  const [signature, setSignature] = useState('');
  const [scheduleAt, setScheduleAt] = useState('');
  const [spam, setSpam] = useState(EMPTY_SPAM);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const spamRequestRef = useRef(0);
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

  const loadConfig = useCallback(async () => {
    const config = await fetchJson('/api/config');
    setPublicBaseUrl(config.publicBaseUrl || '');

    if (config.databaseUnavailable) {
      setComposeNotice({ type: 'error', message: 'Backend is running but database is unavailable. Start MongoDB.' });
    }
  }, []);

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

    Promise.all([loadAuth(), loadConfig()]).catch((error) => {
      setComposeNotice({ type: 'error', message: error.message });
    });
  }, [loadAuth, loadConfig]);

  useEffect(() => {
    const subject = subjectText.trim();
    const composedBody = composeEmailBody(bodyText, signature).trim();
    const requestId = spamRequestRef.current + 1;
    spamRequestRef.current = requestId;

    if (!subject && !composedBody) {
      setSpam(EMPTY_SPAM);
      return undefined;
    }

    let heuristicApplied = false;
    let aiApplied = false;
    const heuristicController = new AbortController();
    const aiController = new AbortController();

    const heuristicTimer = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ subject, body: composedBody, scope: 'full' });
        const heuristic = await fetchJson(`/api/spam-score?${params.toString()}`, {
          signal: heuristicController.signal
        });
        if (spamRequestRef.current !== requestId || aiApplied) {
          return;
        }

        heuristicApplied = true;
        setSpam({
          ...heuristic,
          source: 'heuristic-live'
        });
      } catch (error) {
        if (error?.name === 'AbortError') {
          return;
        }
      }
    }, 140);

    const aiTimer = setTimeout(async () => {
      try {
        const aiResult = await fetchJson('/api/ai/spam-meter', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          signal: aiController.signal,
          body: JSON.stringify({
            subject,
            body: composedBody,
            signature: '',
            scope: 'full'
          })
        });

        if (spamRequestRef.current !== requestId) {
          return;
        }

        aiApplied = true;
        setSpam(aiResult);
      } catch (error) {
        if (error?.name === 'AbortError') {
          return;
        }

        if (spamRequestRef.current !== requestId || heuristicApplied) {
          return;
        }

        setSpam({
          ...EMPTY_SPAM,
          reasons: ['Spam meter unavailable right now.'],
          improvements: ['Check backend/OpenAI connectivity and try again.'],
          source: 'unavailable'
        });
      }
    }, 520);

    return () => {
      clearTimeout(heuristicTimer);
      clearTimeout(aiTimer);
      heuristicController.abort();
      aiController.abort();
    };
  }, [subjectText, bodyText, signature]);

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
      text: 'No account connected'
    };
  }, [auth.connected, auth.activeAccount, auth.activeAccountDetails]);

  const recipientsAvailable = Boolean(flow.excelFile && flow.preview?.total > 0);
  const finalBodyPreview = composeEmailBody(bodyText, signature);
  const finalBodyPreviewMarkup = renderPreviewMarkup(finalBodyPreview);

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

      if (response.disconnected) {
        setConnectionNotice({
          type: 'success',
          message: `Disconnected account: ${response.disconnectedEmail}`
        });
      } else {
        setConnectionNotice({ type: 'error', message: 'No account was disconnected.' });
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

  async function handleSaveBaseUrl() {
    setConnectionNotice(null);

    if (!publicBaseUrl.trim()) {
      setConnectionNotice({ type: 'error', message: 'Provide your ngrok/public URL first.' });
      return;
    }

    try {
      await fetchJson('/api/settings/public-base-url', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ url: publicBaseUrl.trim() })
      });

      setConnectionNotice({ type: 'success', message: 'Tracking URL saved.' });
    } catch (error) {
      setConnectionNotice({ type: 'error', message: error.message });
    }
  }

  async function handleSendCampaign() {
    setComposeNotice(null);

    if (!recipientsAvailable) {
      setComposeNotice({ type: 'error', message: 'Upload recipient Excel sheet first.' });
      return;
    }

    if (!auth.connected) {
      setComposeNotice({ type: 'error', message: 'Connect a sender account before sending campaign emails.' });
      return;
    }

    if (!campaignName.trim()) {
      setComposeNotice({ type: 'error', message: 'Campaign name is required.' });
      return;
    }

    if (!subjectText.trim()) {
      setComposeNotice({ type: 'error', message: 'Subject is required.' });
      return;
    }

    if (!bodyText.trim()) {
      setComposeNotice({ type: 'error', message: 'Body is required.' });
      return;
    }

    const finalBody = composeEmailBody(bodyText, signature);

    setIsSubmitting(true);

    try {
      const formData = new FormData();
      formData.append('excelFile', flow.excelFile);
      formData.append('name', campaignName.trim());
      formData.append('subject', subjectText.trim());
      formData.append('body', finalBody);
      if (scheduleAt) {
        formData.append('scheduleAt', scheduleAt);
      }

      const campaignResult = await fetchJson('/api/campaigns', {
        method: 'POST',
        body: formData
      });

      onRecipientsReady(null, null);
      navigate(`/dashboard?campaign=${encodeURIComponent(campaignResult.campaign.id)}&sent=1`);
    } catch (error) {
      setComposeNotice({ type: 'error', message: error.message });
    } finally {
      setIsSubmitting(false);
    }
  }

  function goToUpload() {
    navigate('/upload');
  }

  return (
    <AppLayout caption="Compose subject/body/signature, verify SMTP credentials in-app, and send exactly what you entered.">
      <header className="page-header">
        <div>
          <h1 className="page-title">Template, Spam Meter & Send</h1>
          <div className="page-subtitle">
            Spam meter checks your typed message content. Campaign sends exactly what you entered in subject/body/signature.
          </div>
        </div>
        <div className={activeAccountBadge.className}>{activeAccountBadge.text}</div>
      </header>

      <section className="split">
        <div className="grid">
          <div className="card">
            <h2>Connection Setup</h2>
            <p>Connect Google/Microsoft account or verify SMTP credentials directly, and save ngrok/public URL for tracking.</p>

            <div className="grid grid-2 space-top">
              <div>
                <label htmlFor="composeAccountSelect">Connected Sender Account</label>
                <select id="composeAccountSelect" value={auth.activeAccount || ''} onChange={handleAccountChange}>
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
                <small className="muted">Connect multiple sender emails and choose active one from the dropdown.</small>
              </div>

              <div>
                <label htmlFor="composePublicBaseUrl">Public Base URL (ngrok)</label>
                <input
                  id="composePublicBaseUrl"
                  type="url"
                  value={publicBaseUrl}
                  onChange={(event) => setPublicBaseUrl(event.target.value)}
                  placeholder="https://example-ngrok.ngrok-free.app"
                />

                <div className="inline-actions">
                  <button className="btn btn-secondary" type="button" onClick={handleSaveBaseUrl}>
                    Save Tracking URL
                  </button>
                </div>
              </div>
            </div>

            <div className="notice space-top">
              <div className="step">
                <span className="step-index">SMTP</span>Verify Organization/Other Email (Password Sign-In)
              </div>

              <div className="grid grid-2 space-top-small">
                <div>
                  <label htmlFor="smtpEmailCompose">Sender Email</label>
                  <input
                    id="smtpEmailCompose"
                    type="email"
                    value={smtp.email}
                    onChange={(event) => handleSmtpFieldChange('email', event.target.value)}
                    placeholder="you@domain.com"
                  />
                </div>
                <div>
                  <label htmlFor="smtpFromNameCompose">From Name (optional)</label>
                  <input
                    id="smtpFromNameCompose"
                    type="text"
                    value={smtp.fromName}
                    onChange={(event) => handleSmtpFieldChange('fromName', event.target.value)}
                    placeholder="Your Name"
                  />
                </div>
              </div>

              <div className="space-top-small">
                <label htmlFor="smtpPasswordCompose">Password / App Password</label>
                <input
                  id="smtpPasswordCompose"
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
              <small className="muted">This verifies credentials directly and connects sender account in this app.</small>
            </div>

            {!auth.hasGoogleConfig && (
              <Notice
                notice={{
                  type: 'notice',
                  message: 'Google OAuth is not configured. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REDIRECT_URI in backend/.env.'
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
            <h2>Email Content</h2>
            <p>Enter exact subject/body/signature to send. Spam meter updates live from your subject and body text.</p>

            {!recipientsAvailable && (
              <div className="notice error">
                No recipient file loaded. Upload Excel first.
                <div className="inline-actions">
                  <button className="btn btn-secondary" type="button" onClick={goToUpload}>
                    Go To Upload
                  </button>
                </div>
              </div>
            )}

            <label htmlFor="campaignName">Campaign Name</label>
            <input
              id="campaignName"
              type="text"
              value={campaignName}
              onChange={(event) => setCampaignName(event.target.value)}
              placeholder="April Product Launch"
            />

            <label htmlFor="subjectText">Subject</label>
            <input
              id="subjectText"
              type="text"
              value={subjectText}
              onChange={(event) => setSubjectText(event.target.value)}
              placeholder="Write subject exactly as you want to send"
            />

            <label htmlFor="bodyText">Body</label>
            <textarea
              id="bodyText"
              value={bodyText}
              onChange={(event) => setBodyText(event.target.value)}
              placeholder="Write email body exactly as you want to send"
            />

            <label htmlFor="signature">Signature</label>
            <textarea
              id="signature"
              value={signature}
              onChange={(event) => setSignature(event.target.value)}
              placeholder="Regards,\nYour Name\nCompany"
            />

            <label htmlFor="scheduleAt">Schedule Time (optional)</label>
            <input
              id="scheduleAt"
              type="datetime-local"
              value={scheduleAt}
              onChange={(event) => setScheduleAt(event.target.value)}
            />

            <div className="step step-gap">
              <span className="step-index">AI</span>Message Spam Meter ({spam.source || 'heuristic'})
            </div>
            <div className={spamBadgeClass(spam.label)}>
              {spam.label} Risk · {spam.score}/100
            </div>
            <div className="meter">
              <div className="meter-fill" style={{ width: `${spam.score}%` }} />
            </div>
            <small className="muted">{(spam.reasons || []).join(' | ') || 'No issues detected.'}</small>

            {(spam.improvements || []).length > 0 && (
              <div className="notice">
                {(spam.improvements || []).map((item, idx) => (
                  <div key={`${item}-${idx}`}>{item}</div>
                ))}
              </div>
            )}

            <div className="inline-actions space-top">
              <button className="btn btn-primary" type="button" disabled={isSubmitting} onClick={handleSendCampaign}>
                {isSubmitting ? 'Sending...' : scheduleAt ? 'Schedule Campaign' : 'Send Campaign'}
              </button>
            </div>

            <Notice notice={composeNotice} />
          </div>
        </div>

        <div className="grid">
          <div className="card">
            <h3>Recipients Loaded</h3>
            <p>{flow.preview ? `${flow.preview.total} recipients are ready.` : 'No recipients loaded yet.'}</p>
            {flow.preview && (
              <div className="preview-list">
                {flow.preview.emails.map((email) => (
                  <div className="preview-item" key={email}>
                    {email}</div>
                ))}
                {flow.preview.total > flow.preview.emails.length && (
                  <div className="preview-item">...and {flow.preview.total - flow.preview.emails.length} more</div>
                )}
              </div>
            )}
          </div>

          <div className="card">
            <h3>Email Preview (As Sent)</h3>
            <label>Subject</label>
            <div className="notice">{subjectText || 'Subject preview appears here.'}</div>

            <label>Body + Signature</label>
            <div className="preview-list">
              <div className="preview-item">
                {finalBodyPreviewMarkup ? (
                  <div className="email-preview-body" dangerouslySetInnerHTML={{ __html: finalBodyPreviewMarkup }} />
                ) : (
                  <pre>Body preview appears here.</pre>
                )}
              </div>
            </div>
          </div>
        </div>
      </section>
    </AppLayout>
  );
}
