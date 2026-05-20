require('dotenv').config();

const express = require('express');
const cors = require('cors');

const authRoutes = require('./routes/auth');
const webhookRoutes = require('./routes/webhook');
const campaignRoutes = require('./routes/campaigns');
const analyticsRoutes = require('./routes/analytics');
const { activeDelays } = require('./services/flowRunner');


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
    version: '2.2.0',
    timestamp: new Date().toISOString(),
    activeDelays: activeDelays.size,
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
  });

  // Keep-alive self-ping — prevents Render free tier from spinning down
  // while flow delays are pending. Pings every 10 minutes.
  const RENDER_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
  setInterval(async () => {
    if (activeDelays.size > 0) {
      console.log(`[KeepAlive] ${activeDelays.size} active delay(s), pinging self...`);
      try {
        const http = require('http');
        http.get(`${RENDER_URL}/`, () => {});
      } catch (e) { /* ignore */ }
    }
  }, 10 * 60 * 1000); // Every 10 minutes

  // Handle server errors (like EADDRINUSE)
  server.on('error', (err) => {
    console.error('💥 Server startup error:', err.message);
    process.exit(1);
  });
}

// Export for Vercel Serverless
module.exports = app;
