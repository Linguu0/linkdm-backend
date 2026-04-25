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
      'instagram_business_basic',
      'instagram_business_manage_messages',
      'instagram_business_manage_comments',
    ].join(',');

    const authUrl =
      `https://www.facebook.com/v21.0/dialog/oauth` +
      `?client_id=${process.env.IG_APP_ID}` +
      `&redirect_uri=${encodeURIComponent(process.env.REDIRECT_URI)}` +
      `&scope=${scopes}` +
      `&response_type=code`;

    console.log('🔗 Redirecting to Facebook OAuth for Instagram Graph API...');
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

    // 2. Exchange for long-lived user token (60 days)
    const longLivedData = await exchangeForLongLivedToken(shortLivedToken);
    const longLivedToken = longLivedData.access_token;

    // 3. Get Instagram User ID and Page Access Token
    const { getInstagramAccountIdAndToken } = require('../services/instagram');
    const { igUserId, accessToken: pageAccessToken } = await getInstagramAccountIdAndToken(longLivedToken);

    // 3. Save / upsert into users table
    const { data, error } = await supabase
      .from('users')
      .upsert(
        {
          ig_user_id: igUserId.toString(),
          access_token: pageAccessToken, // Save the Page Access Token to send DMs
          token_expires_at: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString(), // Roughly 60 days
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
