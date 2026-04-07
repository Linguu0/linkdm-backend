require('dotenv').config();

const express = require('express');
const cors = require('cors');

const authRoutes = require('./routes/auth');
const webhookRoutes = require('./routes/webhook');
const campaignRoutes = require('./routes/campaigns');
const analyticsRoutes = require('./routes/analytics');
const { runMigrations } = require('./db/migrate');

// ---------------------------------------------------------------------------
// Express App
// ---------------------------------------------------------------------------
const app = express();

// Middleware
app.use(cors({
  origin: [
    process.env.FRONTEND_URL,
    'http://localhost:5173',
    'https://linkdm-frontend.vercel.app'
  ].filter(Boolean),
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
  // Run migrations before starting the server
  runMigrations()
    .then(() => {
      app.listen(PORT, () => {
        console.log('');
        console.log('═══════════════════════════════════════════');
        console.log(`  🚀 LinkDM Backend running on port ${PORT}`);
        console.log('═══════════════════════════════════════════');
        console.log(`  📌 Health:     http://localhost:${PORT}/`);
        console.log(`  🔐 Auth:       http://localhost:${PORT}/auth/instagram`);
        console.log(`  🔔 Webhook:    http://localhost:${PORT}/webhook/instagram`);
        console.log(`  📋 Campaigns:  http://localhost:${PORT}/campaigns`);
        console.log(`  📊 Analytics:  http://localhost:${PORT}/analytics`);
        console.log('═══════════════════════════════════════════');
        console.log('');
      });
    })
    .catch((err) => {
      console.error('💥 Failed to run migrations:', err.message);
      // Start anyway — the fallback in campaigns route will handle it
      app.listen(PORT, () => {
        console.log(`  🚀 LinkDM Backend running on port ${PORT} (migrations skipped)`);
      });
    });
}

// Export for Vercel Serverless
module.exports = app;
