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

function formatDateTimeForExport(value) {
  if (!value) {
    return '-';
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return '-';
  }

  const day = String(parsed.getDate()).padStart(2, '0');
  const month = String(parsed.getMonth() + 1).padStart(2, '0');
  const year = parsed.getFullYear();
  const hours = String(parsed.getHours()).padStart(2, '0');
  const minutes = String(parsed.getMinutes()).padStart(2, '0');
  const seconds = String(parsed.getSeconds()).padStart(2, '0');

  return `${day}/${month}/${year}, ${hours}:${minutes}:${seconds}`;
}

function isOpenedRecipient(recipient = {}) {
  return recipient.status === 'OPENED' || recipient.opened_at || Number(recipient.open_count || 0) > 0;
}

function getOpenStatus(recipient = {}) {
  if (isOpenedRecipient(recipient)) {
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
  const recipients = Array.isArray(payload.recipients) ? payload.recipients : [];
  const rows = recipients.map((recipient) => {
    const delivery = String(recipient.status || '').trim();
    return {
      Email: String(recipient.email || ''),
      Delivery: delivery || 'PENDING',
      'Open Status': getOpenStatus(recipient),
      'Sent At': formatDateTimeForExport(recipient.sent_at),
      'Opened At': formatDateTimeForExport(recipient.opened_at),
      'Open Count': Number(recipient.open_count || 0)
    };
  });

  const workbook = XLSX.utils.book_new();
  const recipientsSheet = XLSX.utils.json_to_sheet(rows);
  recipientsSheet['!cols'] = [
    { wch: 38 },
    { wch: 14 },
    { wch: 14 },
    { wch: 22 },
    { wch: 22 },
    { wch: 12 }
  ];
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
