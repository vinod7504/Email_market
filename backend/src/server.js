require('dotenv').config();

const fs = require('fs');
const path = require('path');
const cors = require('cors');
const express = require('express');
const { connectDatabase, isDatabaseConnected, getDatabaseStatus, getSetting, setSetting } = require('./db');
const authRoutes = require('./routes/auth');
const apiRoutes = require('./routes/api');
const { startCampaignScheduler } = require('./services/campaignRunner');

const app = express();
const PORT = Number(process.env.PORT || 3000);
let reconnectIntervalHandle = null;

function normalizeOrigin(value) {
  return String(value || '')
    .trim()
    .replace(/\/+$/, '');
}

function parseAllowedOrigins(value) {
  return String(value || '')
    .split(',')
    .map((origin) => normalizeOrigin(origin))
    .filter(Boolean);
}

function buildAllowedOrigins() {
  const staticOrigins = [
    'https://email-market-rkeb.onrender.com',
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    normalizeOrigin(process.env.CLIENT_URL)
  ].filter(Boolean);

  const configuredOrigins = parseAllowedOrigins(process.env.CORS_ORIGINS);
  if (configuredOrigins.includes('*')) {
    return ['*'];
  }

  return [...new Set([...staticOrigins, ...configuredOrigins])];
}

const allowedOrigins = buildAllowedOrigins();
const corsOptions = {
  origin(origin, callback) {
    if (!origin) {
      return callback(null, true);
    }

    const normalizedOrigin = normalizeOrigin(origin);
    if (allowedOrigins.includes('*') || allowedOrigins.includes(normalizedOrigin)) {
      return callback(null, true);
    }

    return callback(new Error(`Not allowed by CORS: ${normalizedOrigin}`));
  }
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    database: getDatabaseStatus()
  });
});

app.use(authRoutes);
app.use(apiRoutes);

const clientDistPath = path.join(__dirname, '..', '..', 'frontend', 'dist');
const hasClientBuild = fs.existsSync(path.join(clientDistPath, 'index.html'));

if (hasClientBuild) {
  app.use(express.static(clientDistPath));

  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/auth') || req.path.startsWith('/track')) {
      return next();
    }

    return res.sendFile(path.join(clientDistPath, 'index.html'));
  });
} else {
  app.get('/', (_req, res) => {
    res.json({
      message: 'Email marketing API is running.',
      client: process.env.CLIENT_URL || 'http://localhost:5173'
    });
  });
}

app.use((err, _req, res, _next) => {
  if (String(err?.message || '').toLowerCase().includes('not allowed by cors')) {
    return res.status(403).json({ error: err.message });
  }

  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error.' });
});

async function bootstrap() {
  try {
    await connectDatabase();
    console.log('MongoDB connected.');
  } catch (error) {
    console.error('Initial MongoDB connection failed:', error.message || error);
  }

  if (process.env.PUBLIC_BASE_URL && isDatabaseConnected()) {
    const existing = await getSetting('public_base_url');
    if (!existing) {
      await setSetting('public_base_url', String(process.env.PUBLIC_BASE_URL).replace(/\/+$/, ''));
    }
  }

  startCampaignScheduler();

  app.listen(PORT, () => {
    console.log(`Email marketing API running on http://localhost:${PORT}`);
    if (!isDatabaseConnected()) {
      console.log('API running in degraded mode: database unavailable.');
    }
  });

  if (!reconnectIntervalHandle) {
    reconnectIntervalHandle = setInterval(async () => {
      if (isDatabaseConnected()) {
        return;
      }

      try {
        await connectDatabase();
        console.log('MongoDB reconnected.');

        if (process.env.PUBLIC_BASE_URL) {
          const existing = await getSetting('public_base_url');
          if (!existing) {
            await setSetting('public_base_url', String(process.env.PUBLIC_BASE_URL).replace(/\/+$/, ''));
          }
        }
      } catch (reconnectError) {
        console.error('MongoDB reconnect failed:', reconnectError.message || reconnectError);
      }
    }, 15000);
  }
}

bootstrap().catch((error) => {
  console.error('Server bootstrap failed:', error);
  process.exit(1);
});
