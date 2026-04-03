const express = require('express');
const router = express.Router();
const { exchangeCodeForToken, exchangeForLongLivedToken } = require('../services/instagram');
const supabase = require('../db/supabase');

// ---------------------------------------------------------------------------
// GET /auth/instagram — Redirect to Instagram OAuth consent screen
// ---------------------------------------------------------------------------
router.get('/instagram', (req, res) => {
  try {
    const scopes = [
      'instagram_basic',
      'instagram_manage_comments',
      'instagram_business_manage_messages',
    ].join(',');

    const authUrl =
      `https://api.instagram.com/oauth/authorize` +
      `?client_id=${process.env.IG_APP_ID}` +
      `&redirect_uri=${encodeURIComponent(process.env.REDIRECT_URI)}` +
      `&scope=${scopes}` +
      `&response_type=code`;

    console.log('🔗 Redirecting to Instagram OAuth...');
    return res.redirect(authUrl);
  } catch (err) {
    console.error('❌ Auth redirect error:', err.message);
    return res.status(500).json({ error: 'Failed to initiate Instagram auth' });
  }
});

// ---------------------------------------------------------------------------
// GET /auth/callback — Exchange code → short-lived → long-lived token
// ---------------------------------------------------------------------------
router.get('/callback', async (req, res) => {
  try {
    const { code } = req.query;

    if (!code) {
      console.error('❌ No authorization code in callback');
      return res.status(400).json({ error: 'Missing authorization code' });
    }

    console.log('📥 Received auth callback, exchanging code...');

    // 1. Exchange code for short-lived token
    const shortLivedData = await exchangeCodeForToken(code);
    const shortLivedToken = shortLivedData.access_token;
    const igUserId = shortLivedData.user_id;

    // 2. Exchange for long-lived token (60 days)
    const longLivedData = await exchangeForLongLivedToken(shortLivedToken);
    const longLivedToken = longLivedData.access_token;
    const expiresIn = longLivedData.expires_in; // seconds

    // 3. Save / upsert into users table
    const { data, error } = await supabase
      .from('users')
      .upsert(
        {
          ig_user_id: igUserId.toString(),
          access_token: longLivedToken,
          token_expires_at: new Date(
            Date.now() + expiresIn * 1000
          ).toISOString(),
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'ig_user_id' }
      )
      .select();

    if (error) {
      console.error('❌ Supabase upsert error:', error.message);
      return res.status(500).json({ error: 'Failed to save user tokens' });
    }

    console.log(`✅ User ${igUserId} authenticated & saved`);

    // Redirect to frontend with success
    return res.redirect(
      `${process.env.FRONTEND_URL}?auth=success&ig_user_id=${igUserId}`
    );
  } catch (err) {
    console.error('❌ Auth callback error:', err.message);
    return res.status(500).json({ error: 'Authentication failed', details: err.message });
  }
});

module.exports = router;
