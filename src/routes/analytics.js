const express = require('express');
const router = express.Router();
const supabase = require('../db/supabase');

// ---------------------------------------------------------------------------
// GET /analytics — DM logs count grouped by campaign
// ---------------------------------------------------------------------------
router.get('/', async (req, res) => {
  try {
    const igUserId = req.query.ig_user_id || process.env.IG_USER_ID;

    if (!igUserId) {
      return res.status(400).json({ error: 'Missing ig_user_id query param' });
    }

    // 1. Get all campaigns for the user
    const { data: campaigns, error: campError } = await supabase
      .from('campaigns')
      .select('id, name, keyword, is_active')
      .eq('ig_user_id', igUserId);

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

module.exports = router;
