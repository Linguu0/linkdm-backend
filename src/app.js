require('dotenv').config();

const express = require('express');
const cors = require('cors');
const axios = require('axios');

const authRoutes = require('./routes/auth');
const webhookRoutes = require('./routes/webhook');
const campaignRoutes = require('./routes/campaigns');
const analyticsRoutes = require('./routes/analytics');
const { processPendingDelays } = require('./services/flowRunner');
const { ensureTable: ensureRetryTable, processPendingFollowerChecks } = require('./services/followerRetryWorker');
const supabase = require('./db/supabase');

// ---------------------------------------------------------------------------
// One-time migration: resolve any shortcode target_media_ids to numeric IDs
// ---------------------------------------------------------------------------
async function migrateShortcodes() {
  console.log('[Migration] 🔍 Checking for campaigns with shortcode target_media_ids...');

  const { data: campaigns, error } = await supabase
    .from('campaigns')
    .select('id, target_media_id, target_thumbnail, access_token')
    .eq('target_type', 'specific_post')
    .not('target_media_id', 'is', null);

  if (error) {
    console.error('[Migration] ❌ Failed to fetch campaigns:', error.message);
    return;
  }

  // Filter to only campaigns with non-numeric target_media_id (shortcodes)
  const toFix = (campaigns || []).filter(c => c.target_media_id && !/^\d+$/.test(c.target_media_id));

  if (toFix.length === 0) {
    console.log('[Migration] ✅ All campaigns already have numeric media IDs. Nothing to fix.');
    return;
  }

  console.log(`[Migration] ⚠️ Found ${toFix.length} campaign(s) with shortcode IDs. Resolving...`);

  for (const campaign of toFix) {
    const token = campaign.access_token || process.env.ACCESS_TOKEN;
    if (!token) {
      console.log(`[Migration] ⏭️ Skipping campaign ${campaign.id} — no access token`);
      continue;
    }

    try {
      const res = await axios.get(
        `https://graph.instagram.com/v21.0/me/media?fields=id,permalink,thumbnail_url,media_type,timestamp&access_token=${token}`
      );

      const match = res.data.data?.find(m => m.permalink && m.permalink.includes(campaign.target_media_id));

      if (match) {
        const updates = { target_media_id: match.id };
        if (!campaign.target_thumbnail && match.thumbnail_url) {
          updates.target_thumbnail = match.thumbnail_url;
        }

        await supabase.from('campaigns').update(updates).eq('id', campaign.id);
        console.log(`[Migration] ✅ Campaign ${campaign.id}: ${campaign.target_media_id} → ${match.id}`);
      } else {
        console.log(`[Migration] ⚠️ Campaign ${campaign.id}: could not resolve "${campaign.target_media_id}" (post may be too old for recent media)`);
      }
    } catch (err) {
      console.error(`[Migration] ❌ Campaign ${campaign.id}: API error — ${err.message}`);
    }
  }

  console.log('[Migration] 🏁 Shortcode migration complete.');
}

// ---------------------------------------------------------------------------
// Express App
// ---------------------------------------------------------------------------
const app = express();

// Middleware
app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (like mobile apps or curl)
    if (!origin) return callback(null, true);
    
    const allowedOrigins = [
      process.env.FRONTEND_URL,
      'http://localhost:5173',
      'https://linkdm-frontend.vercel.app',
      'https://linkdm-frontend.vercel.app/',
    ].filter(Boolean);

    if (allowedOrigins.indexOf(origin) !== -1 || origin.endsWith('.vercel.app')) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Request logger
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
app.use('/auth', authRoutes);
app.use('/webhook', webhookRoutes);
app.use('/campaigns', campaignRoutes);
app.use('/posts', campaignRoutes);
app.use('/analytics', analyticsRoutes);

// Health check
app.get('/', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'LinkDM Backend',
    version: '2.3.0',
    timestamp: new Date().toISOString(),
  });
});

// 404 handler
app.use((_req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// Global error handler
app.use((err, _req, res, _next) => {
  console.error('💥 Unhandled error:', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;

if (require.main === module) {
  // START SERVER IMMEDIATELY — This is critical to avoid 521 errors on Render
  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log('');
    console.log('═══════════════════════════════════════════');
    console.log(`  🚀 LinkDM Backend is LIVE on port ${PORT}`);
    console.log('═══════════════════════════════════════════');

    // Run one-time migration to fix any old shortcode target_media_ids
    migrateShortcodes().catch(err => {
      console.error('[Migration] ❌ Shortcode migration failed:', err.message);
    });
  });

  // -----------------------------------------------------------------------
  // Delay Poller — checks pending_delays table every 10 seconds
  // This is the CORE reliability mechanism. Delays are stored in Supabase
  // and polled here, so they survive Render spin-downs & server restarts.
  // -----------------------------------------------------------------------
  const POLL_INTERVAL = 10 * 1000; // 10 seconds
  setInterval(async () => {
    try {
      await processPendingDelays();
    } catch (err) {
      console.error('[DelayPoller] ❌ Unhandled error:', err.message);
    }
  }, POLL_INTERVAL);
  console.log(`⏱️  Delay poller started (every ${POLL_INTERVAL / 1000}s)`);

  // -----------------------------------------------------------------------
  // Follower Retry Poller — checks pending_follower_checks every 30 seconds
  // Re-verifies follower status for users who were deferred due to API cache.
  // -----------------------------------------------------------------------
  const RETRY_POLL_INTERVAL = 30 * 1000; // 30 seconds
  ensureRetryTable().catch(err => {
    console.error('[FollowerRetry] ❌ Table setup error:', err.message);
  });
  setInterval(async () => {
    try {
      await processPendingFollowerChecks();
    } catch (err) {
      console.error('[FollowerRetry] ❌ Unhandled error:', err.message);
    }
  }, RETRY_POLL_INTERVAL);
  console.log(`🔄 Follower retry poller started (every ${RETRY_POLL_INTERVAL / 1000}s)`);

  // Keep-alive self-ping — prevents Render free tier from spinning down
  const RENDER_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
  setInterval(async () => {
    console.log(`[KeepAlive] Pinging self to stay alive...`);
    try {
      const http = require('http');
      const https = require('https');
      const client = RENDER_URL.startsWith('https') ? https : http;
      client.get(`${RENDER_URL}/`, () => {});
    } catch (e) { /* ignore */ }
  }, 10 * 60 * 1000); // Every 10 minutes

  // Handle server errors (like EADDRINUSE)
  server.on('error', (err) => {
    console.error('💥 Server startup error:', err.message);
    process.exit(1);
  });
}

// Export for Vercel Serverless
module.exports = app;
