const express = require('express');
const router = express.Router();
const supabase = require('../db/supabase');

// ---------------------------------------------------------------------------
// GET /analytics — DM logs count grouped by campaign
// ---------------------------------------------------------------------------
router.get('/', async (req, res) => {
  try {
    const igUserId = req.query.ig_user_id;
    const defaultIgUserId = process.env.IG_USER_ID;

    let targetIds = [];
    if (igUserId) targetIds.push(igUserId);
    if (defaultIgUserId && defaultIgUserId !== igUserId) targetIds.push(defaultIgUserId);

    if (targetIds.length === 0) {
      return res.status(400).json({ error: 'Missing ig_user_id query param and no default available' });
    }

    // 1. Get all campaigns for the user
    const { data: campaigns, error: campError } = await supabase
      .from('campaigns')
      .select('id, name, keyword, is_active')
      .in('ig_user_id', targetIds);

    if (campError) {
      console.error('❌ Error fetching campaigns for analytics:', campError.message);
      return res.status(500).json({ error: campError.message });
    }

    if (!campaigns || campaigns.length === 0) {
      console.log('ℹ️  No campaigns found for analytics');
      return res.json({ analytics: [] });
    }

    // 2. For each campaign, count dm_logs
    const analytics = [];

    for (const campaign of campaigns) {
      const { count, error: countError } = await supabase
        .from('dm_logs')
        .select('id', { count: 'exact', head: true })
        .eq('campaign_id', campaign.id);

      if (countError) {
        console.error(
          `❌ Error counting DMs for campaign ${campaign.id}:`,
          countError.message
        );
        analytics.push({
          campaign_id: campaign.id,
          campaign_name: campaign.name,
          keyword: campaign.keyword,
          is_active: campaign.is_active,
          dm_count: 0,
          error: countError.message,
        });
        continue;
      }

      analytics.push({
        campaign_id: campaign.id,
        campaign_name: campaign.name,
        keyword: campaign.keyword,
        is_active: campaign.is_active,
        dm_count: count || 0,
      });
    }

    console.log(`📊 Analytics: ${analytics.length} campaigns processed`);
    return res.json({ analytics });
  } catch (err) {
    console.error('❌ GET /analytics error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/debug-logs', async (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const { data } = await supabase.from('dm_logs').select('*').order('sent_at', { ascending: false }).limit(limit);
  res.json(data);
});

router.get('/debug-flow-states', async (req, res) => {
  const { data } = await supabase.from('user_flow_states').select('*, campaigns(name, dm_type)').order('last_updated_at', { ascending: false }).limit(20);
  res.json(data);
});

router.get('/debug-campaigns', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('campaigns')
      .select('id, name, keyword, is_active, ig_user_id, target_type, target_media_id, dm_type, send_once_per_user, dm_message, button_template_data, flow_data')
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/fix-campaign-id', async (req, res) => {
  const { data, error } = await supabase
    .from('campaigns')
    .update({ ig_user_id: '17841462923731141' })
    .eq('id', '8f75719e-c9c0-487d-b4de-cd26d1d4f2aa')
    .select();
  if (error) return res.json({ error: error.message });
  res.json({ fixed: true, data });
});

router.get('/debug-flow-states', async (req, res) => {
  const { data } = await supabase.from('user_flow_states').select('*').order('last_updated_at', { ascending: false }).limit(20);
  res.json(data);
});
router.get('/debug-pending-retries', async (req, res) => {
  const { data, error } = await supabase.from('pending_follower_checks').select('*').order('created_at', { ascending: false }).limit(20);
  if (error) return res.json({ error: error.message });
  res.json(data);
});
router.get('/test-follower/:userId', async (req, res) => {
  const axios = require('axios');
  const userId = req.params.userId;
  const results = {};
  
  // Get the FRESH token from users table (not the stale env variable)
  const { data: userData } = await supabase.from('users').select('access_token').limit(1).single();
  const token = userData?.access_token || process.env.ACCESS_TOKEN;
  
  // Raw IG Graph API call
  try {
    const resp = await axios.get(`https://graph.instagram.com/v21.0/${userId}`, {
      params: { fields: 'is_user_follow_business', access_token: token },
      timeout: 10000,
    });
    results.ig_graph = { status: 'ok', data: resp.data };
  } catch (err) {
    results.ig_graph = { 
      status: 'error', 
      code: err.response?.data?.error?.code,
      type: err.response?.data?.error?.type,
      message: err.response?.data?.error?.message || err.message,
      httpStatus: err.response?.status
    };
  }
  
  res.json({ userId, tokenSource: userData ? 'database' : 'env', tokenStart: token ? token.substring(0, 20) : null, results });
});

// ---------------------------------------------------------------------------
// GET /analytics/insights — Pull Instagram account insights
// ---------------------------------------------------------------------------
router.get('/insights', async (req, res) => {
  try {
    const axios = require('axios');
    
    // Get access token
    const { data: userData } = await supabase
      .from('users')
      .select('access_token, ig_user_id')
      .limit(1)
      .single();
    
    const token = userData?.access_token || process.env.ACCESS_TOKEN;
    const igUserId = userData?.ig_user_id || process.env.IG_USER_ID;
    
    if (!token) {
      return res.status(400).json({ error: 'No access token found' });
    }

    const results = {};

    // 1. Account info (followers, media count)
    try {
      const profileResp = await axios.get(`https://graph.instagram.com/v21.0/me`, {
        params: { 
          fields: 'username,name,followers_count,follows_count,media_count,biography',
          access_token: token 
        },
        timeout: 10000,
      });
      results.profile = profileResp.data;
    } catch (err) {
      results.profile = { error: err.response?.data?.error?.message || err.message };
    }

    // 2. Account-level insights (reach, impressions — last 30 days)
    try {
      const insightsResp = await axios.get(`https://graph.instagram.com/v21.0/me/insights`, {
        params: {
          metric: 'reach,impressions,accounts_engaged,profile_views',
          period: 'day',
          since: Math.floor((Date.now() - 30 * 24 * 60 * 60 * 1000) / 1000),
          until: Math.floor(Date.now() / 1000),
          access_token: token,
        },
        timeout: 15000,
      });
      results.account_insights = insightsResp.data?.data || [];
    } catch (err) {
      results.account_insights = { error: err.response?.data?.error?.message || err.message };
    }

    // 3. Recent media (last 10 posts with engagement)
    try {
      const mediaResp = await axios.get(`https://graph.instagram.com/v21.0/me/media`, {
        params: {
          fields: 'id,caption,media_type,timestamp,like_count,comments_count,permalink',
          limit: 10,
          access_token: token,
        },
        timeout: 10000,
      });
      results.recent_media = mediaResp.data?.data || [];

      // Get insights for each media
      for (let i = 0; i < results.recent_media.length; i++) {
        const media = results.recent_media[i];
        try {
          const mediaInsights = await axios.get(`https://graph.instagram.com/v21.0/${media.id}/insights`, {
            params: {
              metric: 'reach,impressions,saved,shares',
              access_token: token,
            },
            timeout: 10000,
          });
          results.recent_media[i].insights = {};
          for (const m of (mediaInsights.data?.data || [])) {
            results.recent_media[i].insights[m.name] = m.values?.[0]?.value || 0;
          }
        } catch (mErr) {
          results.recent_media[i].insights = { error: mErr.response?.data?.error?.message || mErr.message };
        }
      }
    } catch (err) {
      results.recent_media = { error: err.response?.data?.error?.message || err.message };
    }

    // 4. Our DM stats (from dm_logs)
    try {
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      
      const { data: logs } = await supabase
        .from('dm_logs')
        .select('status, sent_at')
        .gte('sent_at', sevenDaysAgo);
      
      const dmStats = { sent: 0, failed: 0, follow_gate: 0, debug: 0, total: logs?.length || 0 };
      for (const log of (logs || [])) {
        const s = log.status || 'unknown';
        if (dmStats[s] !== undefined) dmStats[s]++;
      }
      
      // Daily breakdown
      const daily = {};
      for (const log of (logs || [])) {
        const day = log.sent_at?.substring(0, 10);
        if (!daily[day]) daily[day] = { sent: 0, follow_gate: 0, failed: 0, debug: 0 };
        const s = log.status || 'unknown';
        if (daily[day][s] !== undefined) daily[day][s]++;
      }
      
      results.dm_stats_7d = { ...dmStats, daily };
    } catch (err) {
      results.dm_stats_7d = { error: err.message };
    }

    res.json(results);
  } catch (err) {
    console.error('Insights error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
