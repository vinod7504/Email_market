const net = require('net');
const tls = require('tls');

function getNodemailer() {
  try {
    // Load lazily so backend can still run Google-only mode without this package.
    return require('nodemailer');
  } catch (_error) {
    return null;
  }
}

function toBoolean(value, defaultValue = true) {
  if (typeof value === 'boolean') {
    return value;
  }

  const lowered = String(value || '').trim().toLowerCase();
  if (!lowered) {
    return defaultValue;
  }

  return !['false', '0', 'no', 'off'].includes(lowered);
}

function createTransport({ fromEmail, host, port, secure, username, password }) {
  const nodemailer = getNodemailer();
  if (!nodemailer) {
    return null;
  }
  const numericPort = Number(port || 465);
  const secureMode = toBoolean(secure, numericPort === 465);

  return nodemailer.createTransport({
    host: String(host || '').trim(),
    port: numericPort,
    secure: secureMode,
    requireTLS: !secureMode,
    tls: {
      servername: String(host || '').trim(),
      rejectUnauthorized: true,
      minVersion: 'TLSv1.2'
    },
    auth: {
      user: String(username || '').trim() || String(fromEmail || '').trim(),
      pass: String(password || '')
    },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000
  });
}

function buildFromHeader(fromEmail, fromName) {
  const cleanEmail = String(fromEmail || '').trim();
  const cleanName = String(fromName || '').trim();

  if (!cleanName) {
    return cleanEmail;
  }

  const escapedName = cleanName.replace(/"/g, '\\"');
  return `"${escapedName}" <${cleanEmail}>`;
}

function createLineReader(socket) {
  let buffer = '';
  const queue = [];
  const waiters = [];

  function pushLine(line) {
    if (waiters.length) {
      const resolve = waiters.shift();
      resolve(line);
      return;
    }
    queue.push(line);
  }

  socket.on('data', (chunk) => {
    buffer += Buffer.from(chunk).toString('utf8');

    while (true) {
      const newlineIdx = buffer.indexOf('\n');
      if (newlineIdx < 0) {
        break;
      }

      const rawLine = buffer.slice(0, newlineIdx).replace(/\r$/, '');
      buffer = buffer.slice(newlineIdx + 1);

      if (!rawLine) {
        continue;
      }

      pushLine(rawLine);
    }
  });

  return function nextLine(timeoutMs = 10000) {
    if (queue.length) {
      return Promise.resolve(queue.shift());
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = waiters.indexOf(onLine);
        if (idx >= 0) {
          waiters.splice(idx, 1);
        }
        reject(new Error('SMTP server timed out while waiting for response.'));
      }, timeoutMs);

      function onLine(line) {
        clearTimeout(timer);
        resolve(line);
      }

      waiters.push(onLine);
    });
  };
}

async function readSmtpResponse(nextLine, timeoutMs = 10000) {
  const lines = [];

  while (true) {
    const line = await nextLine(timeoutMs);
    lines.push(line);

    const match = /^(\d{3})([ -])(.*)$/.exec(line);
    if (!match) {
      continue;
    }

    if (match[2] === ' ') {
      return {
        code: Number(match[1]),
        lines,
        text: lines.join('\n')
      };
    }
  }
}

function sendSmtpCommand(socket, command) {
  return new Promise((resolve, reject) => {
    socket.write(`${command}\r\n`, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function expectSmtpCode(nextLine, expectedCodes, contextLabel, timeoutMs = 10000) {
  const response = await readSmtpResponse(nextLine, timeoutMs);
  const accepted = Array.isArray(expectedCodes) ? expectedCodes : [expectedCodes];

  if (!accepted.includes(response.code)) {
    throw new Error(`${contextLabel} failed. SMTP ${response.code}: ${response.text}`);
  }

  return response;
}

function connectPlainSocket({ host, port }) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    socket.setTimeout(15000);

    socket.once('connect', () => resolve(socket));
    socket.once('error', (error) => reject(error));
    socket.once('timeout', () => reject(new Error('SMTP connection timed out.')));
  });
}

function connectTlsSocket({ host, port, socket = null }) {
  return new Promise((resolve, reject) => {
    const tlsSocket = tls.connect({
      socket: socket || undefined,
      host,
      port,
      servername: host,
      rejectUnauthorized: true,
      minVersion: 'TLSv1.2'
    });

    tlsSocket.setTimeout(15000);
    tlsSocket.once('secureConnect', () => resolve(tlsSocket));
    tlsSocket.once('error', (error) => reject(error));
    tlsSocket.once('timeout', () => reject(new Error('SMTP TLS handshake timed out.')));
  });
}

function closeSocket(socket) {
  if (!socket) {
    return;
  }

  try {
    socket.end();
  } catch (_error) {
    // Ignore shutdown errors.
  }
}

async function withAuthenticatedSmtpSession({ host, port, secure, username, password }, run) {
  const cleanHost = String(host || '').trim();
  const numericPort = Number(port || 465);
  const secureMode = toBoolean(secure, numericPort === 465);
  const authUser = String(username || '').trim();
  const authPass = String(password || '');

  if (!cleanHost) {
    throw new Error('SMTP host is required.');
  }

  if (!authUser || !authPass) {
    throw new Error('SMTP username and password are required.');
  }

  let socket = null;
  let nextLine = null;

  try {
    socket = secureMode
      ? await connectTlsSocket({ host: cleanHost, port: numericPort })
      : await connectPlainSocket({ host: cleanHost, port: numericPort });

    nextLine = createLineReader(socket);
    await expectSmtpCode(nextLine, 220, 'SMTP greeting');
    await sendSmtpCommand(socket, 'EHLO mailpilot.local');
    await expectSmtpCode(nextLine, 250, 'EHLO');

    if (!secureMode) {
      await sendSmtpCommand(socket, 'STARTTLS');
      await expectSmtpCode(nextLine, 220, 'STARTTLS');

      socket = await connectTlsSocket({ host: cleanHost, port: numericPort, socket });
      nextLine = createLineReader(socket);

      await sendSmtpCommand(socket, 'EHLO mailpilot.local');
      await expectSmtpCode(nextLine, 250, 'EHLO after STARTTLS');
    }

    await sendSmtpCommand(socket, 'AUTH LOGIN');
    await expectSmtpCode(nextLine, 334, 'AUTH LOGIN');
    await sendSmtpCommand(socket, Buffer.from(authUser, 'utf8').toString('base64'));
    await expectSmtpCode(nextLine, 334, 'SMTP username');
    await sendSmtpCommand(socket, Buffer.from(authPass, 'utf8').toString('base64'));
    await expectSmtpCode(nextLine, 235, 'SMTP password');

    const result = await run({ socket, nextLine, host: cleanHost, username: authUser });
    await sendSmtpCommand(socket, 'QUIT').catch(() => {});
    return result;
  } finally {
    closeSocket(socket);
  }
}

async function verifySmtpByProtocol({ host, port, secure, username, password }) {
  await withAuthenticatedSmtpSession({ host, port, secure, username, password }, async () => null);
}

function sanitizeHeader(value) {
  return String(value || '')
    .replace(/\r/g, ' ')
    .replace(/\n/g, ' ')
    .trim();
}

function getEmailDomain(email) {
  const normalized = String(email || '').trim().toLowerCase();
  return normalized.includes('@') ? normalized.split('@')[1] : 'localhost';
}

function buildRawMimeMessage({ fromEmail, fromName, toEmail, subject, htmlBody }) {
  const now = new Date();
  const domain = getEmailDomain(fromEmail);
  const messageId = `<${Date.now()}.${Math.random().toString(16).slice(2)}@${domain}>`;

  const headers = [
    `From: ${sanitizeHeader(buildFromHeader(fromEmail, fromName))}`,
    `To: ${sanitizeHeader(String(toEmail || '').trim())}`,
    `Subject: ${sanitizeHeader(subject)}`,
    `Date: ${now.toUTCString()}`,
    `Message-ID: ${messageId}`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit'
  ];

  return `${headers.join('\r\n')}\r\n\r\n${String(htmlBody || '')}\r\n`;
}

function dotStuff(value) {
  return String(value || '').replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');
}

async function writeRaw(socket, value) {
  return new Promise((resolve, reject) => {
    socket.write(value, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function sendSmtpEmailByProtocol({
  fromEmail,
  fromName = '',
  toEmail,
  subject,
  htmlBody,
  host,
  port,
  secure,
  username,
  password
}) {
  return withAuthenticatedSmtpSession(
    {
      host,
      port,
      secure,
      username: String(username || '').trim() || String(fromEmail || '').trim(),
      password
    },
    async ({ socket, nextLine }) => {
      await sendSmtpCommand(socket, `MAIL FROM:<${String(fromEmail || '').trim()}>`);
      await expectSmtpCode(nextLine, [250, 251], 'MAIL FROM');

      await sendSmtpCommand(socket, `RCPT TO:<${String(toEmail || '').trim()}>`);
      await expectSmtpCode(nextLine, [250, 251], 'RCPT TO');

      await sendSmtpCommand(socket, 'DATA');
      await expectSmtpCode(nextLine, 354, 'DATA');

      const rawMessage = buildRawMimeMessage({ fromEmail, fromName, toEmail, subject, htmlBody });
      await writeRaw(socket, `${dotStuff(rawMessage)}\r\n.\r\n`);
      const completion = await expectSmtpCode(nextLine, 250, 'Message send');

      const messageIdMatch = /message-id[:=]\s*<?([^>\s]+)>?/i.exec(completion.text);
      return {
        messageId: messageIdMatch?.[1] || null
      };
    }
  );
}

async function sendSmtpEmail({
  fromEmail,
  fromName = '',
  toEmail,
  subject,
  htmlBody,
  host,
  port,
  secure,
  username,
  password
}) {
  const transporter = createTransport({
    fromEmail,
    host,
    port,
    secure,
    username,
    password
  });

  if (!transporter) {
    return sendSmtpEmailByProtocol({
      fromEmail,
      fromName,
      toEmail,
      subject,
      htmlBody,
      host,
      port,
      secure,
      username,
      password
    });
  }

  const info = await transporter.sendMail({
    from: buildFromHeader(fromEmail, fromName),
    to: String(toEmail || '').trim(),
    subject: String(subject || ''),
    html: String(htmlBody || '')
  });

  return {
    messageId: info?.messageId || null
  };
}

async function verifySmtpConnection({ fromEmail, host, port, secure, username, password }) {
  const cleanHost = String(host || '').trim();
  const numericPort = Number(port || 465);
  const secureMode = toBoolean(secure, numericPort === 465);
  const authUser = String(username || '').trim() || String(fromEmail || '').trim();
  const authPass = String(password || '');

  if (!cleanHost) {
    throw new Error('SMTP host is required.');
  }

  if (!authUser || !authPass) {
    throw new Error('SMTP username and password are required.');
  }

  await verifySmtpByProtocol({
    host: cleanHost,
    port: numericPort,
    secure: secureMode,
    username: authUser,
    password: authPass
  });

  // Keep nodemailer-level verify as a secondary check for transport compatibility when available.
  const transporter = createTransport({ fromEmail, host, port, secure: secureMode, username: authUser, password: authPass });
  if (transporter) {
    await transporter.verify();
  }

  return { ok: true };
}

module.exports = {
  sendSmtpEmail,
  verifySmtpConnection
};
