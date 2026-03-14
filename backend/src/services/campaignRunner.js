const {
  isDatabaseConnected,
  getSetting,
  getGoogleAccount,
  getMicrosoftAccount,
  getSmtpAccount,
  updateGoogleAccountTokens,
  updateMicrosoftAccountTokens,
  getDueCampaigns,
  getPendingRecipients,
  updateCampaignStatus,
  markRecipientSent,
  markRecipientFailed,
  finalizeCampaignStatus
} = require('../db');
const { sendGmailEmail } = require('./google');
const { sendMicrosoftEmail } = require('./microsoft');
const { sendSmtpEmail } = require('./smtp');

let isProcessing = false;
let schedulerHandle = null;

async function getPublicBaseUrl() {
  const settingUrl = await getSetting('public_base_url');
  const envUrl = process.env.TRACKING_BASE_URL || process.env.PUBLIC_BASE_URL;
  const fallback = `http://localhost:${process.env.PORT || 3000}`;

  return String(settingUrl || envUrl || fallback).replace(/\/+$/, '');
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

function isVideoUrl(url) {
  return /\.(mp4|m4v|webm|ogg|ogv|mov)(\?.*)?(#.*)?$/i.test(String(url || '').trim());
}

function normalizeYouTubeVideoId(value) {
  const trimmed = String(value || '').trim();
  return /^[a-zA-Z0-9_-]{11}$/.test(trimmed) ? trimmed : '';
}

function getYouTubeVideoId(url) {
  const trimmed = String(url || '').trim();
  if (!trimmed) {
    return '';
  }

  try {
    const parsed = new URL(trimmed);
    const host = String(parsed.hostname || '').toLowerCase().replace(/^www\./, '');
    const pathParts = String(parsed.pathname || '')
      .split('/')
      .filter(Boolean);

    if (host === 'youtu.be') {
      return normalizeYouTubeVideoId(pathParts[0]);
    }

    if (host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'youtube-nocookie.com') {
      const route = String(pathParts[0] || '').toLowerCase();
      if (route === 'watch') {
        return normalizeYouTubeVideoId(parsed.searchParams.get('v'));
      }

      if (['shorts', 'embed', 'live'].includes(route)) {
        return normalizeYouTubeVideoId(pathParts[1]);
      }

      return normalizeYouTubeVideoId(parsed.searchParams.get('v'));
    }
  } catch (_error) {
    return '';
  }

  return '';
}

function renderLinkedMediaMarkup(url, safeUrl) {
  if (isImageUrl(url)) {
    return `<br/><img src="${safeUrl}" alt="" style="max-width:100%; height:auto; border:0; margin-top:8px;" />`;
  }

  if (isVideoUrl(url)) {
    return [
      '<br/>',
      '<video controls preload="metadata" style="max-width:100%; height:auto; border:0; border-radius:10px; margin-top:8px; background:#000;">',
      `<source src="${safeUrl}" />`,
      'Your email client does not support embedded video.',
      '</video>',
      `<br/><a href="${safeUrl}" target="_blank" rel="noopener noreferrer">Open video</a>`
    ].join('');
  }

  const youtubeVideoId = getYouTubeVideoId(url);
  if (!youtubeVideoId) {
    return '';
  }

  const thumbnailUrl = escapeHtml(`https://img.youtube.com/vi/${youtubeVideoId}/hqdefault.jpg`);
  return [
    '<br/>',
    `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer" style="display:inline-block; margin-top:8px;">`,
    `<img src="${thumbnailUrl}" alt="Watch video" style="max-width:100%; height:auto; border:0; border-radius:10px;" />`,
    '</a>'
  ].join('');
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

function renderPlainTextBody(value) {
  const source = String(value || '');
  const urlPattern = /https?:\/\/[^\s<>"']+/gi;
  let html = '';
  let cursor = 0;

  for (const match of source.matchAll(urlPattern)) {
    const fullUrl = match[0];
    const start = Number(match.index || 0);

    html += escapeHtml(source.slice(cursor, start));

    const { clean, trailing } = trimTrailingPunctuation(fullUrl);
    if (clean) {
      const safeUrl = escapeHtml(clean);
      html += `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer">${safeUrl}</a>`;
      const mediaMarkup = renderLinkedMediaMarkup(clean, safeUrl);
      if (mediaMarkup) {
        html += mediaMarkup;
      }
    }

    html += escapeHtml(trailing);
    cursor = start + fullUrl.length;
  }

  html += escapeHtml(source.slice(cursor));
  return html.replace(/\n/g, '<br/>');
}

function buildMessageMarkup(bodyText) {
  const raw = String(bodyText || '');
  if (!raw.trim()) {
    return '';
  }

  if (containsHtmlMarkup(raw)) {
    return sanitizeHtmlMarkup(raw);
  }

  return renderPlainTextBody(raw);
}

function buildEmailHtml(bodyText, trackingPixelUrl) {
  const messageMarkup = buildMessageMarkup(bodyText);

  return `
    <div style="font-family: Verdana, Geneva, sans-serif; color: #1e293b; line-height: 1.6; font-size: 15px;">
      <div>${messageMarkup}</div>
      <img
        src="${trackingPixelUrl}"
        alt=""
        width="1"
        height="1"
        aria-hidden="true"
        style="width:1px; height:1px; opacity:0.01; border:0; margin:0; padding:0;"
      />
    </div>
  `;
}

async function sendCampaign(campaign) {
  await updateCampaignStatus(campaign.id, 'SENDING');

  const accountType = String(campaign.account_type || 'google').toLowerCase();
  const account = accountType === 'smtp'
    ? await getSmtpAccount(campaign.account_email)
    : accountType === 'microsoft'
      ? await getMicrosoftAccount(campaign.account_email)
      : await getGoogleAccount(campaign.account_email);
  const pendingRecipients = await getPendingRecipients(campaign.id);

  if (!account) {
    for (const recipient of pendingRecipients) {
      await markRecipientFailed(
        recipient.id,
        `${accountType === 'smtp' ? 'SMTP' : accountType === 'microsoft' ? 'Microsoft' : 'Google'} account ${campaign.account_email} is no longer connected.`
      );
    }

    await finalizeCampaignStatus(campaign.id);
    return;
  }

  const baseUrl = await getPublicBaseUrl();
  let latestTokens = account.tokens;

  for (const recipient of pendingRecipients) {
    const trackingUrl = `${baseUrl}/track/open/${encodeURIComponent(recipient.tracking_token)}.gif?mid=${encodeURIComponent(campaign.id)}`;
    const htmlBody = buildEmailHtml(campaign.body_text, trackingUrl);

    try {
      if (accountType === 'smtp') {
        const sendResult = await sendSmtpEmail({
          fromEmail: account.email,
          fromName: account.from_name || '',
          toEmail: recipient.email,
          subject: campaign.subject,
          htmlBody,
          host: account.host,
          port: account.port,
          secure: account.secure,
          username: account.username,
          password: account.password
        });

        await markRecipientSent(recipient.id, sendResult.messageId);
      } else if (accountType === 'microsoft') {
        const sendResult = await sendMicrosoftEmail({
          toEmail: recipient.email,
          subject: campaign.subject,
          htmlBody,
          tokens: latestTokens
        });

        latestTokens = sendResult.tokens;
        await markRecipientSent(recipient.id, sendResult.messageId);
      } else {
        const sendResult = await sendGmailEmail({
          fromEmail: account.email,
          toEmail: recipient.email,
          subject: campaign.subject,
          htmlBody,
          tokens: latestTokens
        });

        latestTokens = sendResult.tokens;
        await markRecipientSent(recipient.id, sendResult.messageId);
      }
    } catch (error) {
      await markRecipientFailed(recipient.id, error?.message || 'Send failed');
    }
  }

  if (accountType === 'google') {
    await updateGoogleAccountTokens(account.email, latestTokens);
  } else if (accountType === 'microsoft') {
    await updateMicrosoftAccountTokens(account.email, latestTokens);
  }
  await finalizeCampaignStatus(campaign.id);
}

async function processDueCampaigns() {
  if (isProcessing) {
    return;
  }

  if (!isDatabaseConnected()) {
    return;
  }

  isProcessing = true;

  try {
    const campaigns = await getDueCampaigns(new Date().toISOString());

    for (const campaign of campaigns) {
      await sendCampaign(campaign);
    }
  } catch (error) {
    console.error('Campaign processing failed:', error);
  } finally {
    isProcessing = false;
  }
}

function startCampaignScheduler() {
  if (schedulerHandle) {
    return;
  }

  schedulerHandle = setInterval(() => {
    processDueCampaigns().catch((error) => {
      console.error('Scheduler iteration failed:', error);
    });
  }, 15000);

  processDueCampaigns().catch((error) => {
    console.error('Initial scheduler run failed:', error);
  });
}

function triggerCampaignProcessing() {
  processDueCampaigns().catch((error) => {
    console.error('Manual campaign trigger failed:', error);
  });
}

module.exports = {
  startCampaignScheduler,
  triggerCampaignProcessing
};
