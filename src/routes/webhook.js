const express = require('express');
const router = express.Router();
const supabase = require('../db/supabase');
const { matchesKeyword } = require('../services/matcher');
const { enqueueDM } = require('../services/dmQueue');
const { advanceFlow } = require('../services/flowRunner');
const { replyToComment } = require('../services/instagram');

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
// POST /webhook/instagram — Receive events from Meta
// ---------------------------------------------------------------------------
router.post('/instagram', async (req, res) => {
  // ALWAYS respond 200 first — Meta requires this within 20 s
  res.sendStatus(200);

  try {
    const body = req.body;
    console.log('📩 Webhook event received:', JSON.stringify(body));

    if (!body || !body.entry) {
      console.log('⚠️  No entry in webhook body, ignoring');
      return;
    }

    if (body.object !== 'instagram') {
      console.log('⚠️  Non-Instagram webhook object, ignoring');
      return;
    }

    for (const entry of body.entry) {
      const webhookUserId = entry.id;

      // ═══════════════════════════════════════════════════════════════════
      // SECTION A: Handle DM Messages (for flow advancement)
      // ═══════════════════════════════════════════════════════════════════
      if (entry.messaging) {
        for (const msg of entry.messaging) {
          const senderId = msg.sender?.id;
          const text = msg.message?.text;

          if (!senderId || !text) continue;

          console.log(`💬 Received DM from ${senderId}: "${text}"`);

          // Find ALL active flow sessions for this user
          const { data: states, error: stateError } = await supabase
            .from('user_flow_states')
            .select('*, campaigns(*)')
            .eq('commenter_id', senderId);

          if (stateError || !states || states.length === 0) {
            console.log(`ℹ️ No active flow state for ${senderId}`);
            continue;
          }

          console.log(`🔄 User ${senderId} has ${states.length} active flow(s)`);

          // Try to advance each flow if it matches the input
          for (const state of states) {
            const campaign = state.campaigns;
            if (!campaign) continue;

            const flow = typeof campaign.flow_data === 'string' ? JSON.parse(campaign.flow_data) : campaign.flow_data;
            if (!flow || !flow.steps) continue;

            const currentIndex = state.current_step_index;
            const currentStep = flow.steps[currentIndex];

            if (!currentStep || currentStep.type !== 'condition') continue;

            console.log(`🔎 Checking condition for campaign "${campaign.name}" at step ${currentIndex}`);

            const keywords = (currentStep.matchKeywords || '').split(',').map(k => k.trim().toLowerCase()).filter(Boolean);
            const isMatch = keywords.length === 0 || keywords.some(k => text.toLowerCase().includes(k));

            if (isMatch) {
              console.log(`✅ Condition match for campaign "${campaign.name}"! Advancing...`);
              await advanceFlow({
                commenterId: senderId,
                campaignId: campaign.id,
                accessToken: campaign.access_token || process.env.ACCESS_TOKEN,
                stepIndex: currentIndex + 1
              });
              break;
            }
          }
        }
      }

      // ═══════════════════════════════════════════════════════════════════
      // SECTION B: Handle Comment Events (main automation trigger)
      // ═══════════════════════════════════════════════════════════════════
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

        // Insert debug log
        try {
          await supabase.from('dm_logs').insert({
            campaign_id: null,
            commenter_id: commenterId,
            comment_id: commentId,
            dm_message: `DEBUG: Post=${mediaId}, Text="${commentText}"`,
            status: 'debug',
            sent_at: new Date().toISOString()
          });
        } catch (e) {
          console.error('Debug insert failed', e.message);
        }

        console.log(`💬 Comment from ${commenterId}: "${commentText}" on media ${mediaId}`);

        // 1. Find active campaigns — try webhook entry.id, then ENV fallback, then ALL
        const envIgUserId = process.env.IG_USER_ID || '17841462923731141';
        let campaigns = null;
        let campError = null;

        // Try with webhook entry.id first
        const result1 = await supabase
          .from('campaigns')
          .select('*')
          .eq('ig_user_id', webhookUserId)
          .eq('is_active', true);

        campaigns = result1.data;
        campError = result1.error;

        // If no campaigns found and env ID is different, try the env ID
        if ((!campaigns || campaigns.length === 0) && envIgUserId !== webhookUserId) {
          console.log(`🔄 No campaigns for webhook ID ${webhookUserId}, trying ENV ID ${envIgUserId}...`);
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
          console.log('ℹ️  No active campaigns found in database');
          continue;
        }

        console.log(`📋 Found ${campaigns.length} active campaign(s). Checking for matches...`);

        // 2. Resolve access token — prefer fresh DB token over ENV fallback
        let accessToken = null;
        if (campaigns.length > 0 && campaigns[0].access_token) {
          accessToken = campaigns[0].access_token;
        }
        if (!accessToken) {
          accessToken = process.env.ACCESS_TOKEN;
        }
        if (!accessToken) {
          console.error('❌ No access token available');
          continue;
        }

        // 3. Check each campaign for target + keyword match
        for (const campaign of campaigns) {
          // --- Target Post Filter ---
          if (campaign.target_type === 'specific_post' && campaign.target_media_id) {
            const isTargetMatch = mediaId === campaign.target_media_id ||
                                 (campaign.target_media_id.length < 15 && mediaId.includes(campaign.target_media_id));

            if (!isTargetMatch) {
              console.log(`⏭️ Skipping "${campaign.name}" — target media mismatch (${campaign.target_media_id} != ${mediaId})`);
              continue;
            }
          }

          // --- Exclude @Mentions Filter (BUG 6 FIX) ---
          if (campaign.exclude_mentions && commentText.includes('@')) {
            console.log(`⏭️ Skipping "${campaign.name}" — comment contains @mention`);
            continue;
          }

          // --- Keyword Match ---
          const isMatch = matchesKeyword(commentText, campaign.keyword);
          console.log(`🔎 "${commentText}" vs keyword "${campaign.keyword}" for "${campaign.name}": ${isMatch ? '✅ MATCH' : '❌ NO MATCH'}`);

          if (!isMatch) continue;

          // --- Exclude Keywords Filter (BUG 7 FIX) ---
          if (campaign.exclude_keywords && campaign.exclude_keywords.length > 0) {
            const excludeList = Array.isArray(campaign.exclude_keywords)
              ? campaign.exclude_keywords
              : (typeof campaign.exclude_keywords === 'string' ? JSON.parse(campaign.exclude_keywords) : []);

            const normalizedComment = commentText.toLowerCase().trim();
            const isExcluded = excludeList.some(ek =>
              typeof ek === 'string' && normalizedComment.includes(ek.toLowerCase().trim())
            );

            if (isExcluded) {
              console.log(`⏭️ Skipping "${campaign.name}" — comment matches exclude keyword`);
              continue;
            }
          }

          console.log(`✅ Keyword match! Campaign "${campaign.name}"`);

          // --- Send Once Per User Check (BUG 1 FIX: exclude debug logs) ---
          let shouldSkip = false;
          if (campaign.send_once_per_user !== false) {
            const { data: existingLogs, error: logError } = await supabase
              .from('dm_logs')
              .select('id')
              .eq('campaign_id', campaign.id)
              .eq('commenter_id', commenterId)
              .neq('status', 'debug')
              .limit(1);

            if (logError) {
              console.error('❌ Error checking dm_logs:', logError.message);
              continue;
            }

            if (existingLogs && existingLogs.length > 0) {
              console.log(`⏭️ Already sent DM to ${commenterId} for campaign ${campaign.id}, skipping`);
              shouldSkip = true;
            }
          }

          if (shouldSkip) continue;

          // ═══ DISPATCH: Flow Builder or Standard DM ═══

          if (campaign.dm_type === 'flow_builder' && campaign.flow_data) {
            console.log(`📥 Starting flow-builder for ${commenterId} on campaign ${campaign.id}`);

            // BUG 3 FIX: Auto-reply to comment for flow_builder campaigns too
            if (campaign.auto_comment_reply && commentId) {
              try {
                const campaignToken = campaign.access_token || accessToken;
                await replyToComment(campaignToken, commentId, 'Check your DMs! 📩');
                console.log(`✅ Auto-replied to comment ${commentId} for flow campaign`);
              } catch (replyErr) {
                console.warn(`⚠️ Failed to auto-reply to comment ${commentId}:`, replyErr.message);
              }
            }

            await advanceFlow({
              commenterId,
              campaignId: campaign.id,
              accessToken,
              commentId,
              stepIndex: 0
            });
            continue;
          }

          // Default single DM handling
          console.log(`🚀 Triggering standard DM for "${campaign.name}" to commenter ${commenterId}`);
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
    console.error('❌ Webhook processing error:', err.message, err.stack);
  }
});

module.exports = router;
