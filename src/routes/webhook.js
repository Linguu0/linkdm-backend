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
    console.log('📩 Webhook event received:', JSON.stringify(body));
    
    if (body.object === 'instagram' && body.entry) {
      body.entry.forEach(e => {
        if (e.messaging) {
          console.log(`ℹ️ Detected messaging event in webhook from ${e.id} (ignoring for comment-to-DM)`);
        }
        if (e.changes) {
          console.log(`ℹ️ Detected changes event in webhook from ${e.id}: ${e.changes.map(c => c.field).join(', ')}`);
        }
      });
    }


    // Instagram webhook payload structure:
    // body.entry[].changes[].field === 'comments'
    // body.entry[].changes[].value  → { id, text, from: { id, username }, media: { id } }

    if (!body || !body.entry) {
      console.log('⚠️  No entry in webhook body, ignoring');
      return;
    }

    for (const entry of body.entry) {
      const webhookUserId = entry.id; // the IG account from webhook

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
        console.log(`🔍 Webhook entry.id = ${webhookUserId}, ENV IG_USER_ID = ${process.env.IG_USER_ID}`);

        // 1. Find active campaigns — try webhook entry.id first, then ENV fallback, then ALL
        const igUserIdToTry = webhookUserId;
        const envIgUserId = process.env.IG_USER_ID || '17841462923731141';

        let campaigns = null;
        let campError = null;

        // Try with webhook entry.id first
        const result1 = await supabase
          .from('campaigns')
          .select('*')
          .eq('ig_user_id', igUserIdToTry)
          .eq('is_active', true);

        campaigns = result1.data;
        campError = result1.error;

        // If no campaigns found and env ID is different, try the env ID
        if ((!campaigns || campaigns.length === 0) && envIgUserId !== igUserIdToTry) {
          console.log(`🔄 No campaigns for webhook ID ${igUserIdToTry}, trying ENV ID ${envIgUserId}...`);
          const result2 = await supabase
            .from('campaigns')
            .select('*')
            .eq('ig_user_id', envIgUserId)
            .eq('is_active', true);

          campaigns = result2.data;
          campError = result2.error;
        }

        // Last resort: just get ALL active campaigns
        if (!campaigns || campaigns.length === 0) {
          console.log('🔄 Still no campaigns, fetching ALL active campaigns...');
          const result3 = await supabase
            .from('campaigns')
            .select('*')
            .eq('is_active', true);

          campaigns = result3.data;
          campError = result3.error;
        }

        if (campError) {
          console.error('❌ Error fetching campaigns:', campError.message);
          continue;
        }

        if (!campaigns || campaigns.length === 0) {
          console.log('ℹ️  No active campaigns found at all');
          continue;
        }

        console.log(`📋 Found ${campaigns.length} active campaign(s): ${campaigns.map(c => `"${c.name}" (ig_user_id=${c.ig_user_id})`).join(', ')}`);

        // 2. Resolve access token — prefer fresh ENV token over stale DB token
        let accessToken = process.env.ACCESS_TOKEN;
        if (!accessToken && campaigns.length > 0 && campaigns[0].access_token) {
          console.log(`ℹ️ Using campaign DB token for ${igUserIdToTry}`);
          accessToken = campaigns[0].access_token;
        }
        if (!accessToken) {
          console.error('❌ No access token available for', igUserIdToTry);
          continue;
        }

        // 3. Check each campaign for target + keyword match
        for (const campaign of campaigns) {
          if (campaign.target_type === 'specific_post' && campaign.target_media_id) {
            if (mediaId !== campaign.target_media_id) {
              console.log(
                `⏭️ skipping campaign "${campaign.name}" — target media mismatch (${campaign.target_media_id} != ${mediaId})`
              );
              continue;
            }
          }

          const isMatch = matchesKeyword(commentText, campaign.keyword);
          console.log(`🔎 Matching "${commentText}" against keyword "${campaign.keyword}" for campaign "${campaign.name}": ${isMatch ? '✅ MATCH' : '❌ NO MATCH'}`);

          if (!isMatch) {
            continue;
          }

          console.log(
            `✅ Keyword match! Campaign "${campaign.name}" keyword "${campaign.keyword}"`
          );

          // 4. Check dm_logs — skip if we already DMed this person for this campaign
          let shouldSkip = false;
          if (campaign.send_once_per_user !== false) {
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
              console.log(`⏭️  Already sent DM to ${commenterId} for campaign ${campaign.id}, skipping`);
              shouldSkip = true;
            }
          }

          if (shouldSkip) continue;

          // 5. Enqueue the DM
          console.log(`🚀 Triggering DM for "${campaign.name}" to commenter ${commenterId}`);
          await enqueueDM({
            commenterId,
            dmMessage: campaign.dm_message,
            type: campaign.dm_type || 'text_message',
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
