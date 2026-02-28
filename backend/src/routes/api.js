const express = require('express');
const multer = require('multer');
const {
  isDatabaseConnected,
  isValidId,
  getSetting,
  setSetting,
  getActiveSenderAccount,
  createCampaign,
  listCampaigns,
  listCampaignRecipients,
  getCampaignById,
  queueCampaignNow,
  markOpenByToken
} = require('../db');
const { extractEmailsFromExcelBuffer, buildCampaignRecipientsWorkbookBuffer } = require('../services/excel');
const { calculateSpamScore } = require('../services/spamScore');
const { hasGoogleConfig } = require('../services/google');
const { hasMicrosoftConfig } = require('../services/microsoft');
const { hasOpenAIConfig, analyzeSpamWithOpenAI } = require('../services/openai');
const { triggerCampaignProcessing } = require('../services/campaignRunner');
const { notifyEmailOpened } = require('../services/trackingWebhook');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024
  }
});

const router = express.Router();

const transparentGif = Buffer.from(
  'R0lGODlhAQABAIABAP///wAAACwAAAAAAQABAAACAkQBADs=',
  'base64'
);

function normalizeUrl(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

function sanitizeFilePart(value, fallback = 'campaign') {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);

  return normalized || fallback;
}

async function getPublicBaseUrl(req) {
  const envUrl = process.env.TRACKING_BASE_URL || process.env.PUBLIC_BASE_URL;
  if (envUrl) {
    return normalizeUrl(envUrl);
  }

  if (isDatabaseConnected()) {
    const settingUrl = await getSetting('public_base_url');
    if (settingUrl) {
      return normalizeUrl(settingUrl);
    }
  }

  return `${req.protocol}://${req.get('host')}`;
}

function buildTrackingPixelUrl(baseUrl, campaignId, trackingToken) {
  return `${baseUrl}/o/webhook-pixel?mid=${encodeURIComponent(campaignId)}&rid=${encodeURIComponent(trackingToken)}`;
}

function parseScheduleDate(value) {
  if (!value) {
    return null;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed.toISOString();
}

function getClientIp(req) {
  const forwardedFor = String(req.headers['x-forwarded-for'] || '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)[0];

  return forwardedFor || req.ip || '';
}

const AUTOMATED_OPEN_UA_PATTERNS = [
  /\bcurl\b/i,
  /\bwget\b/i,
  /\bpython-requests\b/i,
  /\bpostmanruntime\b/i,
  /\binsomnia\b/i,
  /\bnode-fetch\b/i,
  /\bgo-http-client\b/i,
  /\bokhttp\b/i,
  /\bjava\/\d/i,
  /\bapache-httpclient\b/i,
  /\bproofpoint\b/i,
  /\bmimecast\b/i,
  /\bbarracuda\b/i,
  /\bsafelinks\b/i,
  /\bmcafee\b/i,
  /\bsophos\b/i,
  /\bfortimail\b/i,
  /\bmailchannels\b/i,
  /\bavanan\b/i
];

function getTrackingMinSecondsAfterSend() {
  const parsed = Number(process.env.OPEN_TRACK_MIN_SECONDS_AFTER_SEND || 5);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 5;
  }

  return Math.min(Math.round(parsed), 300);
}

function detectAutomatedOpenHit(req) {
  const method = String(req.method || '').toUpperCase();
  if (method === 'HEAD') {
    return { automated: true, reason: 'head_request' };
  }

  const purpose =
    String(req.get('purpose') || '').toLowerCase() ||
    String(req.get('x-purpose') || '').toLowerCase() ||
    String(req.get('sec-purpose') || '').toLowerCase();

  if (purpose.includes('prefetch') || purpose.includes('preview')) {
    return { automated: true, reason: 'prefetch_header' };
  }

  const userAgent = String(req.get('user-agent') || '').trim();
  if (!userAgent) {
    return { automated: true, reason: 'missing_user_agent' };
  }

  const matchedPattern = AUTOMATED_OPEN_UA_PATTERNS.find((pattern) => pattern.test(userAgent));
  if (matchedPattern) {
    return { automated: true, reason: `automated_user_agent:${matchedPattern.source}` };
  }

  return { automated: false, reason: '' };
}

async function processOpenTracking(req, token, options = {}) {
  if (!token || !isDatabaseConnected()) {
    return;
  }

  const skipReason = String(options.skipReason || '').trim();
  if (skipReason) {
    console.log(`Tracking pixel ignored: token=${token} reason=${skipReason}`);
    return;
  }

  try {
    const openEvent = await markOpenByToken(token, {
      minSecondsAfterSent: Number(options.minSecondsAfterSent || 0),
      ignoreBeforeSent: true
    });
    if (!openEvent) {
      console.warn(`Tracking pixel hit with unknown token: ${token}`);
      return;
    }

    if (openEvent.ignored) {
      console.log(
        `Tracking pixel ignored: campaign=${openEvent.campaignId} recipient=${openEvent.recipientId} email=${openEvent.recipientEmail} reason=${openEvent.reason}`
      );
      return;
    }

    console.log(
      `Email opened: campaign=${openEvent.campaignId} recipient=${openEvent.recipientId} email=${openEvent.recipientEmail} openCount=${openEvent.openCount}`
    );

    const webhookResult = await notifyEmailOpened({
      event: 'EMAIL_OPENED',
      status: openEvent.status || 'OPENED',
      campaignId: openEvent.campaignId,
      messageId: String(req.query.mid || '').trim() || null,
      recipientId: openEvent.recipientId,
      recipientEmail: openEvent.recipientEmail,
      trackingToken: openEvent.trackingToken || token,
      openCount: Number(openEvent.openCount || 0),
      openedAt: openEvent.openedAt,
      firstOpen: Boolean(openEvent.isFirstOpen),
      userAgent: req.get('user-agent') || '',
      ipAddress: getClientIp(req),
      referer: req.get('referer') || '',
      path: req.originalUrl,
      occurredAt: new Date().toISOString()
    });

    if (webhookResult && webhookResult.ok === false) {
      console.error('Open tracking webhook call failed:', webhookResult.error || webhookResult);
    } else if (webhookResult && webhookResult.skipped) {
      console.warn(`Open tracking webhook skipped: ${webhookResult.reason}`);
    } else if (webhookResult && webhookResult.ok) {
      console.log(`Open tracking webhook delivered: status=${webhookResult.status}`);
    }
  } catch (error) {
    console.error('Tracking pixel processing failed:', error);
  }
}

function sendTrackingGif(res, options = {}) {
  const shouldSendBody = options.sendBody !== false;
  res.setHeader('Content-Type', 'image/gif');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  if (!shouldSendBody) {
    res.status(200).end();
    return;
  }

  res.status(200).send(transparentGif);
}

async function handlePixelHit(req, res) {
  const token = String(req.params.token || req.query.rid || req.query.token || '').trim();
  const forceTrack = ['1', 'true', 'yes'].includes(String(req.query.force_track || '').trim().toLowerCase());
  const automatedCheck = detectAutomatedOpenHit(req);
  await processOpenTracking(req, token, {
    skipReason: forceTrack ? '' : automatedCheck.automated ? automatedCheck.reason : '',
    minSecondsAfterSent: forceTrack ? 0 : getTrackingMinSecondsAfterSend()
  });
  sendTrackingGif(res, { sendBody: req.method !== 'HEAD' });
}

router.get('/api/config', async (req, res) => {
  try {
    res.json({
      publicBaseUrl: await getPublicBaseUrl(req),
      hasGoogleConfig: hasGoogleConfig(),
      hasMicrosoftConfig: hasMicrosoftConfig(),
      supportsSmtp: true,
      hasOpenAIConfig: hasOpenAIConfig(),
      databaseUnavailable: !isDatabaseConnected()
    });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to load config.' });
  }
});

router.post('/api/settings/public-base-url', async (req, res) => {
  if (!isDatabaseConnected()) {
    return res.status(503).json({ error: 'Database unavailable. Start MongoDB and retry.' });
  }

  const { url } = req.body || {};

  if (!url) {
    return res.status(400).json({ error: 'url is required.' });
  }

  const normalized = normalizeUrl(url);

  if (!/^https?:\/\//i.test(normalized)) {
    return res.status(400).json({ error: 'URL must start with http:// or https://.' });
  }

  try {
    await setSetting('public_base_url', normalized);
    return res.json({ ok: true, publicBaseUrl: normalized });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Failed to save public URL.' });
  }
});

router.post('/api/tracking/test-webhook', async (req, res) => {
  try {
    const payload = {
      event: 'EMAIL_OPENED_TEST',
      status: 'OPENED',
      campaignId: String(req.body?.campaignId || 'test-campaign'),
      messageId: String(req.body?.messageId || 'test-message'),
      recipientId: String(req.body?.recipientId || 'test-recipient'),
      recipientEmail: String(req.body?.recipientEmail || 'test@example.com'),
      trackingToken: String(req.body?.trackingToken || 'test-token'),
      openCount: Number(req.body?.openCount || 1),
      openedAt: new Date().toISOString(),
      firstOpen: true,
      userAgent: 'MailPilot Test',
      ipAddress: '127.0.0.1',
      referer: '',
      path: '/api/tracking/test-webhook',
      occurredAt: new Date().toISOString()
    };

    const result = await notifyEmailOpened(payload);
    return res.json({
      ok: Boolean(result?.ok),
      result,
      sentPayload: payload
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Failed to test open tracking webhook.' });
  }
});

router.get('/api/spam-score', (req, res) => {
  const { subject = '', body = '', scope = 'full' } = req.query;
  const scoreBody = String(scope || '').toLowerCase() === 'subject' ? '' : body;
  const result = calculateSpamScore(subject, scoreBody);
  res.json(result);
});

router.post('/api/ai/spam-meter', async (req, res) => {
  const { subject = '', body = '', signature = '', scope = 'full' } = req.body || {};

  try {
    const result = await analyzeSpamWithOpenAI({
      subject: String(subject || ''),
      body: String(body || ''),
      signature: String(signature || ''),
      scope: String(scope || 'full')
    });

    return res.json(result);
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Failed to analyze spam meter.' });
  }
});

router.post('/api/recipients/preview', upload.single('excelFile'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Please upload an Excel sheet (.xlsx or .xls).' });
  }

  try {
    const emails = extractEmailsFromExcelBuffer(req.file.buffer);
    return res.json({
      total: emails.length,
      emails: emails.slice(0, 500)
    });
  } catch (_error) {
    return res.status(400).json({ error: 'Could not parse the Excel sheet. Please verify file format.' });
  }
});

router.post('/api/campaigns', upload.single('excelFile'), async (req, res) => {
  if (!isDatabaseConnected()) {
    return res.status(503).json({ error: 'Database unavailable. Start MongoDB and retry.' });
  }

  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Excel sheet is required.' });
    }

    const activeAccount = await getActiveSenderAccount();
    if (!activeAccount) {
      return res.status(400).json({ error: 'Connect a sender account before creating a campaign.' });
    }

    const name = String(req.body.name || '').trim();
    const subject = String(req.body.subject || '').trim();
    const bodyText = String(req.body.body || '').trim();
    const scheduleDate = parseScheduleDate(req.body.scheduleAt);

    if (!name) {
      return res.status(400).json({ error: 'Campaign name is required.' });
    }

    if (!subject) {
      return res.status(400).json({ error: 'Subject line is required.' });
    }

    if (!bodyText) {
      return res.status(400).json({ error: 'Email body is required.' });
    }

    if (req.body.scheduleAt && !scheduleDate) {
      return res.status(400).json({ error: 'Invalid schedule date/time.' });
    }

    let recipients;
    try {
      recipients = extractEmailsFromExcelBuffer(req.file.buffer);
    } catch (_error) {
      return res.status(400).json({ error: 'Could not parse the Excel sheet. Please verify file format.' });
    }

    if (!recipients.length) {
      return res.status(400).json({ error: 'No valid email addresses found in the uploaded sheet.' });
    }

    const spam = await analyzeSpamWithOpenAI({
      subject,
      body: bodyText,
      signature: ''
    });
    const now = Date.now();
    const scheduleTs = scheduleDate ? new Date(scheduleDate).getTime() : 0;
    const status = scheduleDate && scheduleTs > now ? 'SCHEDULED' : 'QUEUED';

    const campaign = await createCampaign({
      name,
      subject,
      bodyText,
      spamScore: spam.score,
      spamLabel: spam.label,
      status,
      scheduledAt: status === 'SCHEDULED' ? scheduleDate : null,
      accountEmail: activeAccount.email,
      accountType: activeAccount.provider || 'google',
      recipientEmails: recipients
    });

    if (status === 'QUEUED') {
      triggerCampaignProcessing();
    }

    return res.json({
      ok: true,
      campaign,
      recipientCount: recipients.length,
      spam
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Failed to create campaign.' });
  }
});

router.get('/api/campaigns', async (_req, res) => {
  if (!isDatabaseConnected()) {
    return res.status(503).json({ error: 'Database unavailable. Start MongoDB and retry.' });
  }

  try {
    const campaigns = await listCampaigns();
    res.json({ campaigns });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to load campaigns.' });
  }
});

router.get('/api/campaigns/:id/recipients', async (req, res) => {
  if (!isDatabaseConnected()) {
    return res.status(503).json({ error: 'Database unavailable. Start MongoDB and retry.' });
  }

  const campaignId = String(req.params.id || '').trim();

  if (!isValidId(campaignId)) {
    return res.status(400).json({ error: 'Invalid campaign id.' });
  }

  try {
    const campaign = await getCampaignById(campaignId);
    if (!campaign) {
      return res.status(404).json({ error: 'Campaign not found.' });
    }

    const baseUrl = await getPublicBaseUrl(req);
    const recipients = (await listCampaignRecipients(campaignId)).map((recipient) => ({
      ...recipient,
      trackingPixelUrl: buildTrackingPixelUrl(baseUrl, campaignId, recipient.tracking_token)
    }));
    return res.json({
      campaign,
      recipients
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Failed to load recipients.' });
  }
});

router.get('/api/campaigns/:id/recipients/export.xlsx', async (req, res) => {
  if (!isDatabaseConnected()) {
    return res.status(503).json({ error: 'Database unavailable. Start MongoDB and retry.' });
  }

  const campaignId = String(req.params.id || '').trim();
  const openedOnly = ['1', 'true', 'yes'].includes(String(req.query.openedOnly || '').toLowerCase());

  if (!isValidId(campaignId)) {
    return res.status(400).json({ error: 'Invalid campaign id.' });
  }

  try {
    const campaign = await getCampaignById(campaignId);
    if (!campaign) {
      return res.status(404).json({ error: 'Campaign not found.' });
    }

    const recipients = await listCampaignRecipients(campaignId);
    const filteredRecipients = openedOnly
      ? recipients.filter(
          (recipient) =>
            recipient.status === 'OPENED' || Boolean(recipient.opened_at) || Number(recipient.open_count || 0) > 0
        )
      : recipients;

    const workbookBuffer = buildCampaignRecipientsWorkbookBuffer({
      campaign,
      recipients: filteredRecipients,
      exportTypeLabel: openedOnly ? 'Opened Recipients' : 'All Recipients'
    });
    const campaignSlug = sanitizeFilePart(campaign.name, 'campaign');
    const dateStamp = new Date().toISOString().slice(0, 10);
    const fileName = openedOnly
      ? `${campaignSlug}-opened-recipients-${dateStamp}.xlsx`
      : `${campaignSlug}-recipients-${dateStamp}.xlsx`;

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    return res.status(200).send(workbookBuffer);
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Failed to export recipients.' });
  }
});

router.post('/api/campaigns/:id/send-now', async (req, res) => {
  if (!isDatabaseConnected()) {
    return res.status(503).json({ error: 'Database unavailable. Start MongoDB and retry.' });
  }

  const campaignId = String(req.params.id || '').trim();

  if (!isValidId(campaignId)) {
    return res.status(400).json({ error: 'Invalid campaign id.' });
  }

  try {
    const campaign = await getCampaignById(campaignId);
    if (!campaign) {
      return res.status(404).json({ error: 'Campaign not found.' });
    }

    await queueCampaignNow(campaignId);
    triggerCampaignProcessing();

    return res.json({ ok: true });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Failed to queue campaign.' });
  }
});

router.get('/track/open/:token.gif', async (req, res) => {
  await handlePixelHit(req, res);
});

router.head('/track/open/:token.gif', async (req, res) => {
  await handlePixelHit(req, res);
});

router.get('/o/pixel', async (req, res) => {
  await handlePixelHit(req, res);
});

router.get('/o/webhook-pixel', async (req, res) => {
  await handlePixelHit(req, res);
});

router.get('/o/webhook-pixel.gif', async (req, res) => {
  await handlePixelHit(req, res);
});

router.head('/o/pixel', async (req, res) => {
  await handlePixelHit(req, res);
});

router.head('/o/webhook-pixel', async (req, res) => {
  await handlePixelHit(req, res);
});

router.head('/o/webhook-pixel.gif', async (req, res) => {
  await handlePixelHit(req, res);
});

module.exports = router;
