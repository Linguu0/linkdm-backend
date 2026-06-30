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

router.get('/debug-logs', async (req, res) => { const { data } = await supabase.from('dm_logs').select('*').order('sent_at', { ascending: false }).limit(10); res.json(data); });

router.get('/debug-campaigns', async (req, res) => {
  const { data } = await supabase.from('campaigns').select('id, name, keyword, is_active, ig_user_id, target_type, target_media_id, dm_type, send_once_per_user').eq('is_active', true);
  res.json(data);
});

router.get('/fix-campaign-id', async (req, res) => {
  const { data, error } = await supabase
    .from('campaigns')
    .update({ ig_user_id: '17841462923731141' })
    .eq('id', '8f75719e-c9c0-487d-b4de-cd26d1d4f2aa')
    .select();
router.get('/debug-flow-states', async (req, res) => {
  const { data } = await supabase.from('user_flow_states').select('*').order('last_updated_at', { ascending: false }).limit(20);
  res.json(data);
});
module.exports = router;
