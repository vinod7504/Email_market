const XLSX = require('xlsx');

const EMAIL_REGEX = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

function extractEmailsFromExcelBuffer(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const allEmails = new Set();

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false });

    for (const row of rows) {
      if (!Array.isArray(row)) {
        continue;
      }

      const rowContent = row
        .filter((cell) => cell !== null && cell !== undefined)
        .map((cell) => String(cell))
        .join(' ');

      const matches = rowContent.match(EMAIL_REGEX);
      if (!matches) {
        continue;
      }

      for (const email of matches) {
        allEmails.add(String(email).trim().toLowerCase());
      }
    }
  }

  return [...allEmails];
}

function toIsoOrEmpty(value) {
  if (!value) {
    return '';
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return '';
  }

  return parsed.toISOString();
}

function getOpenStatus(recipient = {}) {
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

function buildCampaignRecipientsWorkbookBuffer(payload = {}) {
  const campaign = payload.campaign || {};
  const recipients = Array.isArray(payload.recipients) ? payload.recipients : [];
  const exportTypeLabel = String(payload.exportTypeLabel || 'All Recipients');

  const rows = recipients.map((recipient) => ({
    Campaign: String(campaign.name || ''),
    CampaignStatus: String(campaign.status || ''),
    Email: String(recipient.email || ''),
    DeliveryStatus: String(recipient.status || ''),
    OpenStatus: getOpenStatus(recipient),
    SentAt: toIsoOrEmpty(recipient.sent_at),
    OpenedAt: toIsoOrEmpty(recipient.opened_at),
    OpenCount: Number(recipient.open_count || 0),
    Error: String(recipient.error || ''),
    TrackingToken: String(recipient.tracking_token || ''),
    MessageId: String(recipient.message_id || '')
  }));

  const summaryRows = [
    { Metric: 'Campaign Name', Value: String(campaign.name || '') },
    { Metric: 'Campaign ID', Value: String(campaign.id || '') },
    { Metric: 'Status', Value: String(campaign.status || '') },
    { Metric: 'Subject', Value: String(campaign.subject || '') },
    { Metric: 'Export Type', Value: exportTypeLabel },
    { Metric: 'Created At', Value: toIsoOrEmpty(campaign.created_at) },
    { Metric: 'Scheduled At', Value: toIsoOrEmpty(campaign.scheduled_at) },
    { Metric: 'Campaign Recipients', Value: Number(campaign.total_recipients || 0) },
    { Metric: 'Exported Recipients', Value: Number(recipients.length || 0) }
  ];

  const workbook = XLSX.utils.book_new();
  const recipientsSheet = XLSX.utils.json_to_sheet(rows);
  const summarySheet = XLSX.utils.json_to_sheet(summaryRows);

  XLSX.utils.book_append_sheet(workbook, summarySheet, 'Campaign');
  XLSX.utils.book_append_sheet(workbook, recipientsSheet, 'Recipients');

  return XLSX.write(workbook, {
    bookType: 'xlsx',
    type: 'buffer'
  });
}

module.exports = {
  extractEmailsFromExcelBuffer,
  buildCampaignRecipientsWorkbookBuffer
};
