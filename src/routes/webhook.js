const express = require('express');
const router = express.Router();
const supabase = require('../db/supabase');
const { matchesKeyword } = require('../services/matcher');
const { enqueueDM } = require('../services/dmQueue');

// ---------------------------------------------------------------------------
// GET /webhook/instagram — Meta webhook verification (challenge handshake)
// ---------------------------------------------------------------------------
router.get('/instagram', (req, res) => {
  try {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    console.log('🔔 Webhook verification request received');

    if (mode === 'subscribe' && token === process.env.VERIFY_TOKEN) {
      console.log('✅ Webhook verified successfully');
      return res.status(200).send(challenge);
    }

    console.error('❌ Webhook verification failed — token mismatch');
    return res.sendStatus(403);
  } catch (err) {
    console.error('❌ Webhook GET error:', err.message);
    return res.sendStatus(500);
  }
});

// ---------------------------------------------------------------------------
// POST /webhook/instagram — Receive comment events from Meta
// ---------------------------------------------------------------------------
router.post('/instagram', async (req, res) => {
  // ALWAYS respond 200 first — Meta requires this within 20 s
  res.sendStatus(200);

  try {
    const body = req.body;
    console.log('📩 Webhook event received:', JSON.stringify(body).substring(0, 300));
    
    // TEMPORARY PROBE
    try {
      await supabase.from('dm_logs').insert({
        campaign_id: '541ff3e8-99eb-4786-8820-4602014b663d',
        commenter_id: 'META_PROBE_' + Date.now(),
        dm_message: JSON.stringify(body).substring(0, 1000),
        type: 'probe',
        sent_at: new Date().toISOString()
      });
    } catch(e) {}

    // Instagram webhook payload structure:
    // body.entry[].changes[].field === 'comments'
    // body.entry[].changes[].value  → { id, text, from: { id, username }, media: { id } }

    if (!body || !body.entry) {
      console.log('⚠️  No entry in webhook body, ignoring');
      return;
    }

    for (const entry of body.entry) {
      const igUserId = entry.id; // the IG account that owns the media

      if (!entry.changes) continue;

      for (const change of entry.changes) {
        if (change.field !== 'comments') continue;

        const value = change.value;
        const commenterId = value.from?.id;
        const commentId = value.id;
        const commentText = value.text;
        const mediaId = value.media?.id;

        if (!commenterId || !commentText || !commentId) {
          console.log('⚠️  Missing commenter or text, skipping');
          continue;
        }

        console.log(
          `💬 Comment from ${commenterId}: "${commentText}" on media ${mediaId}`
        );

        // 1. Find active campaigns for this IG account
        const { data: campaigns, error: campError } = await supabase
          .from('campaigns')
          .select('*')
          .eq('ig_user_id', igUserId)
          .eq('is_active', true);

        if (campError) {
          console.error('❌ Error fetching campaigns:', campError.message);
          continue;
        }

        if (!campaigns || campaigns.length === 0) {
          console.log('ℹ️  No active campaigns for this account');
          continue;
        }

        let accessToken = null;
        if (campaigns && campaigns.length > 0 && campaigns[0].access_token) {
          accessToken = campaigns[0].access_token;
        } else if (process.env.ACCESS_TOKEN) {
          console.log(`ℹ️ Falling back to ENV ACCESS_TOKEN for ${igUserId}`);
          accessToken = process.env.ACCESS_TOKEN;
        } else {
          console.error('❌ Could not find campaign token for', igUserId);
          continue;
        }

        // 3. Check each campaign for target + keyword match
        for (const campaign of campaigns) {
          // Filter by target post if campaign targets a specific post
          if (campaign.target_type === 'specific_post' && campaign.target_media_id) {
            if (mediaId !== campaign.target_media_id) {
              console.log(
                `⏭️  Skipping campaign "${campaign.name}" — target media ${campaign.target_media_id} ≠ ${mediaId}`
              );
              continue;
            }
          }

          if (!matchesKeyword(commentText, campaign.keyword)) {
            console.log(
              `❌ No match: "${commentText}" vs keyword "${campaign.keyword}"`
            );
            continue;
          }

          console.log(
            `✅ Keyword match! Campaign "${campaign.name}" keyword "${campaign.keyword}"`
          );

          // 4. Check dm_logs — skip if we already DMed this person for this campaign
          const { data: existingLogs, error: logError } = await supabase
            .from('dm_logs')
            .select('id')
            .eq('campaign_id', campaign.id)
            .eq('commenter_id', commenterId)
            .limit(1);

          if (logError) {
            console.error('❌ Error checking dm_logs:', logError.message);
            continue;
          }

          if (existingLogs && existingLogs.length > 0) {
            console.log(
              `⏭️  Already sent DM to ${commenterId} for campaign ${campaign.id}, skipping`
            );
            continue;
          }

          // 5. Enqueue the DM
          await enqueueDM({
            commenterId,
            dmMessage: campaign.dm_message,
            type: campaign.type || 'link',
            campaignId: campaign.id,
            accessToken,
            commentId,
            autoReply: campaign.auto_comment_reply || false,
          });
        }
      }
    }
  } catch (err) {
    console.error('❌ Webhook processing error:', err.message);
    // We already sent 200, so nothing else to do
  }
});

module.exports = router;
