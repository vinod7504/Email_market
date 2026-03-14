const crypto = require('crypto');
const mongoose = require('mongoose');

const { Schema, model, Types } = mongoose;
mongoose.set('bufferCommands', false);

let lastDatabaseError = null;

mongoose.connection.on('connected', () => {
  lastDatabaseError = null;
});

mongoose.connection.on('error', (error) => {
  lastDatabaseError = error;
});

const settingSchema = new Schema(
  {
    key: { type: String, required: true, unique: true, index: true },
    value: { type: String, required: true }
  },
  { versionKey: false }
);

const googleAccountSchema = new Schema(
  {
    email: { type: String, required: true, unique: true, index: true },
    token_json: { type: Schema.Types.Mixed, required: true },
    connected_at: { type: Date, required: true },
    updated_at: { type: Date, required: true }
  },
  { versionKey: false }
);

googleAccountSchema.index({ updated_at: -1 });

const microsoftAccountSchema = new Schema(
  {
    email: { type: String, required: true, unique: true, index: true },
    token_json: { type: Schema.Types.Mixed, required: true },
    connected_at: { type: Date, required: true },
    updated_at: { type: Date, required: true }
  },
  { versionKey: false }
);

microsoftAccountSchema.index({ updated_at: -1 });

const smtpAccountSchema = new Schema(
  {
    email: { type: String, required: true, unique: true, index: true },
    host: { type: String, required: true },
    port: { type: Number, required: true },
    secure: { type: Boolean, required: true, default: true },
    username: { type: String, required: true },
    password: { type: String, required: true },
    from_name: { type: String, default: '' },
    connected_at: { type: Date, required: true },
    updated_at: { type: Date, required: true }
  },
  { versionKey: false }
);

smtpAccountSchema.index({ updated_at: -1 });

const campaignSchema = new Schema(
  {
    name: { type: String, required: true },
    subject: { type: String, required: true },
    body_text: { type: String, required: true },
    spam_score: { type: Number, required: true },
    spam_label: { type: String, required: true },
    status: { type: String, required: true },
    scheduled_at: { type: Date, default: null },
    owner_email: { type: String, default: null, index: true },
    account_email: { type: String, required: true },
    account_type: { type: String, required: true, default: 'google' },
    total_recipients: { type: Number, required: true },
    created_at: { type: Date, required: true },
    updated_at: { type: Date, required: true }
  },
  { versionKey: false }
);

campaignSchema.index({ status: 1, scheduled_at: 1 });
campaignSchema.index({ created_at: -1 });
campaignSchema.index({ owner_email: 1, created_at: -1 });

const recipientSchema = new Schema(
  {
    campaign_id: { type: Schema.Types.ObjectId, ref: 'Campaign', required: true, index: true },
    email: { type: String, required: true },
    status: { type: String, required: true },
    tracking_token: { type: String, required: true, unique: true, index: true },
    message_id: { type: String, default: null },
    error: { type: String, default: null },
    sent_at: { type: Date, default: null },
    opened_at: { type: Date, default: null },
    open_count: { type: Number, required: true, default: 0 },
    created_at: { type: Date, required: true },
    updated_at: { type: Date, required: true }
  },
  { versionKey: false }
);

const appUserSchema = new Schema(
  {
    email: { type: String, required: true, unique: true, index: true },
    username: { type: String, unique: true, sparse: true, index: true },
    password_hash: { type: String, required: true },
    role: { type: String, required: true, default: 'user' },
    created_at: { type: Date, required: true },
    updated_at: { type: Date, required: true },
    last_login_at: { type: Date, default: null }
  },
  { versionKey: false }
);

appUserSchema.index({ role: 1, updated_at: -1 });

const appSessionSchema = new Schema(
  {
    token_hash: { type: String, required: true, unique: true, index: true },
    email: { type: String, required: true, index: true },
    role: { type: String, required: true, default: 'user' },
    expires_at: { type: Date, required: true },
    created_at: { type: Date, required: true },
    updated_at: { type: Date, required: true }
  },
  { versionKey: false }
);

appSessionSchema.index({ expires_at: 1 }, { expireAfterSeconds: 0 });
appSessionSchema.index({ email: 1, updated_at: -1 });

const Setting = model('Setting', settingSchema);
const GoogleAccount = model('GoogleAccount', googleAccountSchema);
const MicrosoftAccount = model('MicrosoftAccount', microsoftAccountSchema);
const SmtpAccount = model('SmtpAccount', smtpAccountSchema);
const Campaign = model('Campaign', campaignSchema);
const Recipient = model('Recipient', recipientSchema);
const AppUser = model('AppUser', appUserSchema);
const AppSession = model('AppSession', appSessionSchema);

function nowDate() {
  return new Date();
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function normalizeUsername(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeRole(role) {
  return String(role || '').trim().toLowerCase() === 'admin' ? 'admin' : 'user';
}

function buildActiveAccountSettingKey(userEmail) {
  const normalizedUserEmail = normalizeEmail(userEmail);
  if (!normalizedUserEmail) {
    return 'active_account_email';
  }

  return `active_account_email:${normalizedUserEmail}`;
}

function hashSessionToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function createSessionToken() {
  return crypto.randomBytes(32).toString('hex');
}

function hashPassword(password, saltHex) {
  const salt = String(saltHex || crypto.randomBytes(16).toString('hex'));
  const derived = crypto.scryptSync(String(password || ''), salt, 64).toString('hex');
  return `scrypt$${salt}$${derived}`;
}

function verifyPasswordHash(password, passwordHash) {
  const parts = String(passwordHash || '').split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') {
    return false;
  }

  const [, salt, expected] = parts;
  if (!salt || !expected) {
    return false;
  }

  const calculated = crypto.scryptSync(String(password || ''), salt, 64).toString('hex');
  const expectedBuffer = Buffer.from(expected, 'hex');
  const calculatedBuffer = Buffer.from(calculated, 'hex');
  if (!expectedBuffer.length || expectedBuffer.length !== calculatedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(expectedBuffer, calculatedBuffer);
}

function normalizePort(port, fallback = 465) {
  const parsed = Number(port);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 65535) {
    return fallback;
  }

  return Math.round(parsed);
}

function normalizeSecureFlag(secure) {
  if (typeof secure === 'boolean') {
    return secure;
  }

  const lowered = String(secure || '').trim().toLowerCase();
  if (!lowered) {
    return true;
  }

  if (['false', '0', 'no', 'off'].includes(lowered)) {
    return false;
  }

  return true;
}

function generateTrackingToken() {
  return crypto.randomBytes(16).toString('hex');
}

function isValidId(id) {
  return Types.ObjectId.isValid(String(id || ''));
}

function serializeDocument(document) {
  if (!document) {
    return null;
  }

  const row = typeof document.toObject === 'function' ? document.toObject() : { ...document };
  const serialized = { ...row, id: String(row._id) };
  delete serialized._id;

  if (serialized.campaign_id && typeof serialized.campaign_id === 'object') {
    serialized.campaign_id = String(serialized.campaign_id._id || serialized.campaign_id);
  }

  return serialized;
}

function asObjectId(id) {
  return new Types.ObjectId(String(id));
}

function normalizeAccountType(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'smtp') {
    return 'smtp';
  }

  if (normalized === 'microsoft') {
    return 'microsoft';
  }

  return 'google';
}

async function connectDatabase() {
  if (mongoose.connection.readyState === 1) {
    return;
  }

  const mongoUri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/email_marketing';
  await mongoose.connect(mongoUri, {
    serverSelectionTimeoutMS: 5000
  });
  lastDatabaseError = null;
}

function isDatabaseConnected() {
  return mongoose.connection.readyState === 1;
}

function getDatabaseStatus() {
  return {
    connected: isDatabaseConnected(),
    readyState: mongoose.connection.readyState,
    error: lastDatabaseError ? String(lastDatabaseError.message || lastDatabaseError) : null
  };
}

async function setSetting(key, value) {
  await Setting.findOneAndUpdate(
    { key },
    { $set: { value: String(value) } },
    {
      upsert: true,
      setDefaultsOnInsert: true
    }
  );
}

async function getSetting(key) {
  const row = await Setting.findOne({ key }).lean();
  return row ? row.value : null;
}

async function setActiveAccountEmail(email, userEmail = '') {
  await setSetting(buildActiveAccountSettingKey(userEmail), normalizeEmail(email));
}

async function getActiveAccountEmail(userEmail = '') {
  return getSetting(buildActiveAccountSettingKey(userEmail));
}

async function clearActiveAccountEmail(userEmail = '') {
  await Setting.deleteOne({ key: buildActiveAccountSettingKey(userEmail) });
}

async function createAppUser(payload = {}) {
  const email = normalizeEmail(payload.email);
  const username = normalizeUsername(payload.username);
  const password = String(payload.password || '');
  const role = normalizeRole(payload.role || 'user');

  if (!email) {
    throw new Error('Email is required.');
  }

  if (!username) {
    throw new Error('Username is required.');
  }

  if (!password) {
    throw new Error('Password is required.');
  }

  const existingEmail = await AppUser.findOne({ email }).lean();
  if (existingEmail) {
    throw new Error('User already exists for this email.');
  }

  const existingUsername = await AppUser.findOne({ username }).lean();
  if (existingUsername) {
    throw new Error('Username is already taken.');
  }

  const now = nowDate();
  await AppUser.create({
    email,
    username,
    password_hash: hashPassword(password),
    role,
    created_at: now,
    updated_at: now,
    last_login_at: null
  });

  return {
    email,
    username,
    role
  };
}

async function getAppUserByEmail(email) {
  const normalized = normalizeEmail(email);
  if (!normalized) {
    return null;
  }

  const row = await AppUser.findOne({ email: normalized }).lean();
  if (!row) {
    return null;
  }

  return {
    email: row.email,
    username: String(row.username || ''),
    role: normalizeRole(row.role),
    created_at: row.created_at,
    updated_at: row.updated_at,
    last_login_at: row.last_login_at
  };
}

async function verifyAppUserCredentials(identifier, password) {
  const loginValue = String(identifier || '').trim();
  if (!loginValue || !password) {
    return null;
  }

  const isEmailLogin = loginValue.includes('@');
  const normalizedValue = isEmailLogin ? normalizeEmail(loginValue) : normalizeUsername(loginValue);
  if (!normalizedValue) {
    return null;
  }

  const row = await AppUser.findOne(isEmailLogin ? { email: normalizedValue } : { username: normalizedValue }).lean();
  if (!row || !verifyPasswordHash(password, row.password_hash)) {
    return null;
  }

  return {
    email: row.email,
    username: String(row.username || ''),
    role: normalizeRole(row.role)
  };
}

async function updateAppUserPassword(email, password) {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) {
    throw new Error('Email is required.');
  }

  if (!String(password || '')) {
    throw new Error('Password is required.');
  }

  await AppUser.updateOne(
    { email: normalizedEmail },
    {
      $set: {
        password_hash: hashPassword(password),
        updated_at: nowDate()
      }
    }
  );
}

async function createAppSession(payload = {}) {
  const email = normalizeEmail(payload.email);
  const role = normalizeRole(payload.role || 'user');
  const ttlDaysRaw = Number(payload.ttlDays || 7);
  const ttlDays = Number.isFinite(ttlDaysRaw) && ttlDaysRaw > 0 ? Math.min(ttlDaysRaw, 30) : 7;

  if (!email) {
    throw new Error('Session email is required.');
  }

  const now = nowDate();
  const expiresAt = new Date(now.getTime() + Math.round(ttlDays * 24 * 60 * 60 * 1000));
  const token = createSessionToken();

  await AppSession.create({
    token_hash: hashSessionToken(token),
    email,
    role,
    expires_at: expiresAt,
    created_at: now,
    updated_at: now
  });

  await AppUser.updateOne({ email }, { $set: { last_login_at: now, updated_at: now } });

  return {
    token,
    email,
    role,
    expiresAt: expiresAt.toISOString()
  };
}

async function getAppSessionByToken(token) {
  const tokenValue = String(token || '').trim();
  if (!tokenValue) {
    return null;
  }

  const now = nowDate();
  const row = await AppSession.findOne({
    token_hash: hashSessionToken(tokenValue),
    expires_at: { $gt: now }
  }).lean();

  if (!row) {
    return null;
  }

  return {
    email: row.email,
    role: normalizeRole(row.role),
    expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null
  };
}

async function revokeAppSession(token) {
  const tokenValue = String(token || '').trim();
  if (!tokenValue) {
    return false;
  }

  const result = await AppSession.deleteOne({ token_hash: hashSessionToken(tokenValue) });
  return Boolean(result.deletedCount);
}

async function saveGoogleAccount(email, tokens) {
  const normalized = normalizeEmail(email);
  const now = nowDate();

  await GoogleAccount.findOneAndUpdate(
    { email: normalized },
    {
      $set: {
        email: normalized,
        token_json: tokens,
        updated_at: now
      },
      $setOnInsert: {
        connected_at: now
      }
    },
    {
      upsert: true,
      setDefaultsOnInsert: true
    }
  );
}

async function updateGoogleAccountTokens(email, tokens) {
  await GoogleAccount.findOneAndUpdate(
    { email: normalizeEmail(email) },
    { $set: { token_json: tokens, updated_at: nowDate() } }
  );
}

async function getGoogleAccount(email) {
  const row = await GoogleAccount.findOne({ email: normalizeEmail(email) }).lean();
  if (!row) {
    return null;
  }

  return {
    ...serializeDocument(row),
    tokens: row.token_json
  };
}

async function getActiveGoogleAccount(userEmail = '') {
  const email = await getActiveAccountEmail(userEmail);
  if (!email) {
    return null;
  }

  return getGoogleAccount(email);
}

async function saveMicrosoftAccount(email, tokens) {
  const normalized = normalizeEmail(email);
  const now = nowDate();

  await MicrosoftAccount.findOneAndUpdate(
    { email: normalized },
    {
      $set: {
        email: normalized,
        token_json: tokens,
        updated_at: now
      },
      $setOnInsert: {
        connected_at: now
      }
    },
    {
      upsert: true,
      setDefaultsOnInsert: true
    }
  );
}

async function updateMicrosoftAccountTokens(email, tokens) {
  await MicrosoftAccount.findOneAndUpdate(
    { email: normalizeEmail(email) },
    { $set: { token_json: tokens, updated_at: nowDate() } }
  );
}

async function getMicrosoftAccount(email) {
  const row = await MicrosoftAccount.findOne({ email: normalizeEmail(email) }).lean();
  if (!row) {
    return null;
  }

  return {
    ...serializeDocument(row),
    tokens: row.token_json
  };
}

async function saveSmtpAccount(payload = {}) {
  const email = normalizeEmail(payload.email);
  if (!email) {
    throw new Error('SMTP email is required.');
  }

  const host = String(payload.host || '').trim();
  const username = String(payload.username || '').trim() || email;
  const password = String(payload.password || '');
  const fromName = String(payload.fromName || payload.from_name || '').trim();

  if (!host) {
    throw new Error('SMTP host is required.');
  }

  if (!username) {
    throw new Error('SMTP username is required.');
  }

  if (!password) {
    throw new Error('SMTP password is required.');
  }

  const now = nowDate();

  await SmtpAccount.findOneAndUpdate(
    { email },
    {
      $set: {
        email,
        host,
        port: normalizePort(payload.port),
        secure: normalizeSecureFlag(payload.secure),
        username,
        password,
        from_name: fromName,
        updated_at: now
      },
      $setOnInsert: {
        connected_at: now
      }
    },
    {
      upsert: true,
      setDefaultsOnInsert: true
    }
  );

  return getSmtpAccount(email);
}

async function getSmtpAccount(email) {
  const row = await SmtpAccount.findOne({ email: normalizeEmail(email) }).lean();
  return serializeDocument(row);
}

function buildAccountEmailFilter(options = {}) {
  const includeAll = Boolean(options.includeAll);
  const ownerEmail = normalizeEmail(options.ownerEmail);
  if (includeAll || !ownerEmail) {
    return {};
  }

  return { email: ownerEmail };
}

async function listSmtpAccounts(options = {}) {
  const rows = await SmtpAccount.find(buildAccountEmailFilter(options), { password: 0 }).sort({ updated_at: -1 }).lean();
  return rows.map(serializeDocument);
}

async function listGoogleAccounts(options = {}) {
  const accountFilter = buildAccountEmailFilter(options);
  const activeUserEmail = normalizeEmail(options.ownerEmail);
  const [rows, activeEmail] = await Promise.all([
    GoogleAccount.find(accountFilter, { email: 1, connected_at: 1, updated_at: 1 }).sort({ updated_at: -1 }).lean(),
    getActiveAccountEmail(activeUserEmail)
  ]);

  return rows.map((row) => ({
    ...serializeDocument(row),
    provider: 'google',
    is_active: row.email === activeEmail
  }));
}

async function listMicrosoftAccounts(options = {}) {
  const accountFilter = buildAccountEmailFilter(options);
  const activeUserEmail = normalizeEmail(options.ownerEmail);
  const [rows, activeEmail] = await Promise.all([
    MicrosoftAccount.find(accountFilter, { email: 1, connected_at: 1, updated_at: 1 }).sort({ updated_at: -1 }).lean(),
    getActiveAccountEmail(activeUserEmail)
  ]);

  return rows.map((row) => ({
    ...serializeDocument(row),
    provider: 'microsoft',
    is_active: row.email === activeEmail
  }));
}

async function listConnectedAccounts(options = {}) {
  const accountFilter = buildAccountEmailFilter(options);
  const activeUserEmail = normalizeEmail(options.ownerEmail);
  const [googleAccounts, microsoftAccounts, smtpAccounts, activeEmail] = await Promise.all([
    GoogleAccount.find(accountFilter, { email: 1, connected_at: 1, updated_at: 1 }).sort({ updated_at: -1 }).lean(),
    MicrosoftAccount.find(accountFilter, { email: 1, connected_at: 1, updated_at: 1 }).sort({ updated_at: -1 }).lean(),
    SmtpAccount.find(accountFilter, { email: 1, connected_at: 1, updated_at: 1, host: 1, port: 1, secure: 1, from_name: 1 })
      .sort({ updated_at: -1 })
      .lean(),
    getActiveAccountEmail(activeUserEmail)
  ]);

  const merged = [
    ...googleAccounts.map((row) => ({
      ...serializeDocument(row),
      provider: 'google',
      is_active: row.email === activeEmail
    })),
    ...microsoftAccounts.map((row) => ({
      ...serializeDocument(row),
      provider: 'microsoft',
      is_active: row.email === activeEmail
    })),
    ...smtpAccounts.map((row) => ({
      ...serializeDocument(row),
      provider: 'smtp',
      is_active: row.email === activeEmail
    }))
  ];

  return merged.sort((a, b) => new Date(b.updated_at || 0).getTime() - new Date(a.updated_at || 0).getTime());
}

async function getConnectedAccount(email, options = {}) {
  const normalized = normalizeEmail(email);
  const ownerEmail = normalizeEmail(options.ownerEmail);
  const includeAll = Boolean(options.includeAll);
  if (!normalized) {
    return null;
  }

  if (!includeAll && ownerEmail && normalized !== ownerEmail) {
    return null;
  }

  const google = await getGoogleAccount(normalized);
  if (google) {
    return {
      ...google,
      provider: 'google'
    };
  }

  const microsoft = await getMicrosoftAccount(normalized);
  if (microsoft) {
    return {
      ...microsoft,
      provider: 'microsoft'
    };
  }

  const smtp = await getSmtpAccount(normalized);
  if (smtp) {
    return {
      ...smtp,
      provider: 'smtp'
    };
  }

  return null;
}

async function getActiveSenderAccount(userEmail = '', options = {}) {
  const normalizedUserEmail = normalizeEmail(userEmail);
  const activeEmail = await getActiveAccountEmail(normalizedUserEmail);
  if (!activeEmail) {
    return null;
  }

  const account = await getConnectedAccount(activeEmail, {
    ownerEmail: normalizedUserEmail,
    includeAll: options.includeAll
  });
  if (!account) {
    await clearActiveAccountEmail(normalizedUserEmail);
    return null;
  }

  return account;
}

async function disconnectGoogleAccount(email, userEmail = '') {
  const normalizedEmail = normalizeEmail(email);
  const normalizedUserEmail = normalizeEmail(userEmail);
  if (!normalizedEmail) {
    return {
      disconnected: false,
      disconnectedEmail: null,
      activeAccount: await getActiveAccountEmail(normalizedUserEmail)
    };
  }

  const result = await GoogleAccount.deleteOne({ email: normalizedEmail });
  const activeEmail = await getActiveAccountEmail(normalizedUserEmail);

  if (activeEmail === normalizedEmail) {
    const fallback = await GoogleAccount.findOne(buildAccountEmailFilter({ ownerEmail: normalizedUserEmail }), { email: 1 })
      .sort({ updated_at: -1 })
      .lean();
    if (fallback?.email) {
      await setActiveAccountEmail(fallback.email, normalizedUserEmail);
    } else {
      await clearActiveAccountEmail(normalizedUserEmail);
    }
  }

  return {
    disconnected: result.deletedCount > 0,
    disconnectedEmail: normalizedEmail,
    activeAccount: await getActiveAccountEmail(normalizedUserEmail)
  };
}

async function disconnectConnectedAccount(email, userEmail = '', options = {}) {
  const normalizedEmail = normalizeEmail(email);
  const normalizedUserEmail = normalizeEmail(userEmail);
  const includeAll = Boolean(options.includeAll);

  if (!includeAll && normalizedUserEmail && normalizedEmail && normalizedEmail !== normalizedUserEmail) {
    return {
      disconnected: false,
      disconnectedEmail: normalizedEmail,
      activeAccount: await getActiveAccountEmail(normalizedUserEmail)
    };
  }

  if (!normalizedEmail) {
    return {
      disconnected: false,
      disconnectedEmail: null,
      activeAccount: await getActiveAccountEmail(normalizedUserEmail)
    };
  }

  const [googleResult, microsoftResult, smtpResult] = await Promise.all([
    GoogleAccount.deleteOne({ email: normalizedEmail }),
    MicrosoftAccount.deleteOne({ email: normalizedEmail }),
    SmtpAccount.deleteOne({ email: normalizedEmail })
  ]);

  const activeEmail = await getActiveAccountEmail(normalizedUserEmail);
  if (activeEmail === normalizedEmail) {
    const fallbackFilter = buildAccountEmailFilter({
      ownerEmail: normalizedUserEmail,
      includeAll
    });
    const [googleFallback, microsoftFallback, smtpFallback] = await Promise.all([
      GoogleAccount.findOne(fallbackFilter, { email: 1, updated_at: 1 }).sort({ updated_at: -1 }).lean(),
      MicrosoftAccount.findOne(fallbackFilter, { email: 1, updated_at: 1 }).sort({ updated_at: -1 }).lean(),
      SmtpAccount.findOne(fallbackFilter, { email: 1, updated_at: 1 }).sort({ updated_at: -1 }).lean()
    ]);

    const fallbackCandidates = [googleFallback, microsoftFallback, smtpFallback].filter(Boolean);
    fallbackCandidates.sort((a, b) => new Date(b.updated_at || 0).getTime() - new Date(a.updated_at || 0).getTime());

    if (fallbackCandidates[0]?.email) {
      await setActiveAccountEmail(fallbackCandidates[0].email, normalizedUserEmail);
    } else {
      await clearActiveAccountEmail(normalizedUserEmail);
    }
  }

  return {
    disconnected: Boolean(googleResult.deletedCount || microsoftResult.deletedCount || smtpResult.deletedCount),
    disconnectedEmail: normalizedEmail,
    activeAccount: await getActiveAccountEmail(normalizedUserEmail)
  };
}

function buildCampaignOwnershipFilter(options = {}) {
  const includeAll = Boolean(options.includeAll);
  const ownerEmail = normalizeEmail(options.ownerEmail);
  if (includeAll || !ownerEmail) {
    return {};
  }

  return {
    $or: [
      { owner_email: ownerEmail },
      { owner_email: null, account_email: ownerEmail },
      { owner_email: { $exists: false }, account_email: ownerEmail }
    ]
  };
}

async function createCampaign(payload) {
  const deduped = [...new Set(payload.recipientEmails.map(normalizeEmail).filter(Boolean))];

  if (!deduped.length) {
    throw new Error('No valid recipient emails found in the sheet.');
  }

  const now = nowDate();

  const campaign = await Campaign.create({
    name: payload.name,
    subject: payload.subject,
    body_text: payload.bodyText,
    spam_score: payload.spamScore,
    spam_label: payload.spamLabel,
    status: payload.status,
    scheduled_at: payload.scheduledAt ? new Date(payload.scheduledAt) : null,
    owner_email: normalizeEmail(payload.ownerEmail || payload.accountEmail),
    account_email: normalizeEmail(payload.accountEmail),
    account_type: normalizeAccountType(payload.accountType || 'google'),
    total_recipients: deduped.length,
    created_at: now,
    updated_at: now
  });

  await Recipient.insertMany(
    deduped.map((email) => ({
      campaign_id: campaign._id,
      email,
      status: 'PENDING',
      tracking_token: generateTrackingToken(),
      created_at: now,
      updated_at: now
    }))
  );

  return serializeDocument(campaign);
}

async function getCampaignById(id, options = {}) {
  if (!isValidId(id)) {
    return null;
  }

  const ownershipFilter = buildCampaignOwnershipFilter(options);
  const query = { _id: asObjectId(id), ...ownershipFilter };
  const row = await Campaign.findOne(query).lean();
  return serializeDocument(row);
}

async function updateCampaignStatus(id, status) {
  if (!isValidId(id)) {
    return;
  }

  await Campaign.updateOne(
    { _id: asObjectId(id) },
    { $set: { status, updated_at: nowDate() } }
  );
}

async function queueCampaignNow(id) {
  if (!isValidId(id)) {
    return;
  }

  await Campaign.updateOne(
    { _id: asObjectId(id) },
    { $set: { status: 'QUEUED', scheduled_at: null, updated_at: nowDate() } }
  );
}

async function getDueCampaigns(currentIso) {
  const now = new Date(currentIso);

  const rows = await Campaign.find({
    status: { $in: ['QUEUED', 'SCHEDULED'] },
    $or: [{ scheduled_at: null }, { scheduled_at: { $lte: now } }]
  })
    .sort({ created_at: 1 })
    .lean();

  return rows.map(serializeDocument);
}

async function getPendingRecipients(campaignId) {
  if (!isValidId(campaignId)) {
    return [];
  }

  const rows = await Recipient.find({
    campaign_id: asObjectId(campaignId),
    status: 'PENDING'
  })
    .sort({ created_at: 1 })
    .lean();

  return rows.map(serializeDocument);
}

async function markRecipientSent(recipientId, messageId) {
  if (!isValidId(recipientId)) {
    return;
  }

  const ts = nowDate();

  await Recipient.updateOne(
    { _id: asObjectId(recipientId) },
    { $set: { status: 'SENT', message_id: messageId || null, sent_at: ts, updated_at: ts } }
  );
}

async function markRecipientFailed(recipientId, errorMessage) {
  if (!isValidId(recipientId)) {
    return;
  }

  await Recipient.updateOne(
    { _id: asObjectId(recipientId) },
    {
      $set: {
        status: 'FAILED',
        error: (errorMessage || 'Unknown send error').slice(0, 500),
        updated_at: nowDate()
      }
    }
  );
}

async function finalizeCampaignStatus(campaignId) {
  if (!isValidId(campaignId)) {
    return 'FAILED';
  }

  const [counts] = await Recipient.aggregate([
    {
      $match: {
        campaign_id: asObjectId(campaignId)
      }
    },
    {
      $group: {
        _id: null,
        sent_count: {
          $sum: {
            $cond: [{ $in: ['$status', ['SENT', 'OPENED']] }, 1, 0]
          }
        },
        failed_count: {
          $sum: {
            $cond: [{ $eq: ['$status', 'FAILED'] }, 1, 0]
          }
        },
        pending_count: {
          $sum: {
            $cond: [{ $eq: ['$status', 'PENDING'] }, 1, 0]
          }
        }
      }
    }
  ]);

  const sentCount = Number(counts?.sent_count || 0);
  const failedCount = Number(counts?.failed_count || 0);
  const pendingCount = Number(counts?.pending_count || 0);

  let status = 'COMPLETED';
  if (pendingCount > 0) {
    status = 'SENDING';
  } else if (sentCount > 0 && failedCount > 0) {
    status = 'PARTIAL';
  } else if (sentCount === 0 && failedCount > 0) {
    status = 'FAILED';
  }

  await updateCampaignStatus(campaignId, status);
  return status;
}

async function listCampaigns(options = {}) {
  const ownershipFilter = buildCampaignOwnershipFilter(options);
  const campaigns = await Campaign.find(ownershipFilter).sort({ created_at: -1 }).lean();

  if (!campaigns.length) {
    return [];
  }

  const campaignObjectIds = campaigns.map((campaign) => campaign._id);

  const counts = await Recipient.aggregate([
    {
      $match: {
        campaign_id: { $in: campaignObjectIds }
      }
    },
    {
      $group: {
        _id: '$campaign_id',
        sent_count: {
          $sum: {
            $cond: [{ $in: ['$status', ['SENT', 'OPENED']] }, 1, 0]
          }
        },
        opened_count: {
          $sum: {
            $cond: [{ $eq: ['$status', 'OPENED'] }, 1, 0]
          }
        },
        failed_count: {
          $sum: {
            $cond: [{ $eq: ['$status', 'FAILED'] }, 1, 0]
          }
        },
        pending_count: {
          $sum: {
            $cond: [{ $eq: ['$status', 'PENDING'] }, 1, 0]
          }
        }
      }
    }
  ]);

  const countMap = new Map(counts.map((row) => [String(row._id), row]));

  return campaigns.map((campaign) => {
    const serialized = serializeDocument(campaign);
    const rowCount = countMap.get(serialized.id) || {};

    return {
      ...serialized,
      sent_count: Number(rowCount.sent_count || 0),
      opened_count: Number(rowCount.opened_count || 0),
      failed_count: Number(rowCount.failed_count || 0),
      pending_count: Number(rowCount.pending_count || 0)
    };
  });
}

async function countCampaignRecipients(campaignId) {
  if (!isValidId(campaignId)) {
    return 0;
  }

  return Recipient.countDocuments({ campaign_id: asObjectId(campaignId) });
}

async function listCampaignRecipients(campaignId, options = {}) {
  if (!isValidId(campaignId)) {
    return [];
  }

  const parsedPage = Number(options.page || 1);
  const parsedLimit = Number(options.limit || 0);
  const page = Number.isFinite(parsedPage) && parsedPage > 0 ? Math.round(parsedPage) : 1;
  const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.min(Math.round(parsedLimit), 2000) : 0;
  const skip = limit > 0 ? (page - 1) * limit : 0;

  let query = Recipient.find({ campaign_id: asObjectId(campaignId) }).sort({ created_at: 1 });
  if (limit > 0) {
    query = query.skip(skip).limit(limit);
  }

  const rows = await query.lean();
  return rows.map(serializeDocument);
}

async function markOpenByToken(trackingToken, options = {}) {
  const token = String(trackingToken || '').trim();
  if (!token) {
    return null;
  }

  const minSecondsAfterSent = Math.max(0, Number(options.minSecondsAfterSent || 0));
  const ignoreBeforeSent = Boolean(options.ignoreBeforeSent);

  const recipient = await Recipient.findOne({ tracking_token: token });
  if (!recipient) {
    return null;
  }

  if (ignoreBeforeSent && !recipient.sent_at) {
    return {
      ignored: true,
      reason: 'recipient_not_sent_yet',
      recipientId: String(recipient._id),
      campaignId: String(recipient.campaign_id),
      recipientEmail: recipient.email,
      trackingToken: token
    };
  }

  if (minSecondsAfterSent > 0 && recipient.sent_at) {
    const now = Date.now();
    const sentAtMs = new Date(recipient.sent_at).getTime();
    if (Number.isFinite(sentAtMs)) {
      const elapsedSeconds = Math.floor((now - sentAtMs) / 1000);
      if (elapsedSeconds >= 0 && elapsedSeconds < minSecondsAfterSent) {
        return {
          ignored: true,
          reason: 'too_soon_after_send',
          elapsedSeconds,
          minSecondsAfterSent,
          recipientId: String(recipient._id),
          campaignId: String(recipient.campaign_id),
          recipientEmail: recipient.email,
          trackingToken: token
        };
      }
    }
  }

  const isFirstOpen = recipient.open_count === 0;

  recipient.open_count += 1;
  recipient.opened_at = recipient.opened_at || nowDate();
  recipient.updated_at = nowDate();
  if (recipient.status !== 'FAILED') {
    recipient.status = 'OPENED';
  }

  await recipient.save();

  return {
    recipientId: String(recipient._id),
    campaignId: String(recipient.campaign_id),
    recipientEmail: recipient.email,
    trackingToken: token,
    status: recipient.status,
    openCount: Number(recipient.open_count || 0),
    openedAt: recipient.opened_at ? new Date(recipient.opened_at).toISOString() : null,
    isFirstOpen
  };
}

module.exports = {
  connectDatabase,
  isValidId,
  isDatabaseConnected,
  getDatabaseStatus,
  getSetting,
  setSetting,
  getActiveAccountEmail,
  clearActiveAccountEmail,
  setActiveAccountEmail,
  createAppUser,
  getAppUserByEmail,
  verifyAppUserCredentials,
  updateAppUserPassword,
  createAppSession,
  getAppSessionByToken,
  revokeAppSession,
  saveGoogleAccount,
  saveMicrosoftAccount,
  saveSmtpAccount,
  updateGoogleAccountTokens,
  updateMicrosoftAccountTokens,
  getGoogleAccount,
  getMicrosoftAccount,
  getSmtpAccount,
  getActiveGoogleAccount,
  getActiveSenderAccount,
  listGoogleAccounts,
  listMicrosoftAccounts,
  listSmtpAccounts,
  listConnectedAccounts,
  getConnectedAccount,
  disconnectGoogleAccount,
  disconnectConnectedAccount,
  createCampaign,
  getCampaignById,
  updateCampaignStatus,
  queueCampaignNow,
  getDueCampaigns,
  getPendingRecipients,
  markRecipientSent,
  markRecipientFailed,
  finalizeCampaignStatus,
  listCampaigns,
  countCampaignRecipients,
  listCampaignRecipients,
  markOpenByToken
};
