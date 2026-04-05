require('dotenv').config();

const express = require('express');
const cors = require('cors');

const authRoutes = require('./routes/auth');
const webhookRoutes = require('./routes/webhook');
const campaignRoutes = require('./routes/campaigns');
const analyticsRoutes = require('./routes/analytics');

// ---------------------------------------------------------------------------
// Express App
// ---------------------------------------------------------------------------
const app = express();

// Middleware
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  credentials: true,
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Request logger
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// Debug Supabase Connection
app.get('/debug-supabase', async (req, res) => {
  try {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_KEY;
    
    if (!url || !key) {
      return res.json({ 
        status: '❌ Missing Env Vars', 
        url_present: !!url, 
        key_present: !!key 
      });
    }

    const { createClient } = require('@supabase/supabase-js');
    const supabase = createClient(url, key);
    const { error } = await supabase.from('campaigns').select('count', { count: 'exact', head: true });
    
    return res.json({
      status: error ? '❌ Supabase Error' : '✅ Success',
      error_message: error ? error.message : null,
      masked_url: url.substring(0, 15) + '...',
      masked_key: key.substring(0, 10) + '...' + key.substring(key.length - 4),
      key_length: key.length
    });
  } catch (err) {
    return res.json({ status: '❌ Crash', error: err.message });
  }
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
}

// Export for Vercel Serverless
module.exports = app;
