const express = require('express');
const router = express.Router();
const supabase = require('../db/supabase');
const { matchesKeyword } = require('../services/matcher');
const { enqueueDM } = require('../services/dmQueue');
const { advanceFlow } = require('../services/flowRunner');
const { replyToComment, isFollower } = require('../services/instagram');

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
          const text = msg.message?.quick_reply?.payload || msg.message?.text || msg.postback?.payload || msg.postback?.title;

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

            // If flow is past the end or no step exists, clean up
            if (!currentStep) {
              await supabase.from('user_flow_states').delete()
                .eq('commenter_id', senderId)
                .eq('campaign_id', campaign.id);
              continue;
            }

            const campaignToken = campaign.access_token || process.env.ACCESS_TOKEN;

            // --- CONDITION STEP: check keyword match ---
            if (currentStep.type === 'condition') {
              console.log(`🔎 Checking condition for campaign "${campaign.name}" at step ${currentIndex}`);

              const keywords = (currentStep.matchKeywords || '').split(',').map(k => k.trim().toLowerCase()).filter(Boolean);
              const isMatch = keywords.length === 0 || keywords.some(k => text.toLowerCase().includes(k));

              if (!isMatch) continue;

              console.log(`✅ Condition match for campaign "${campaign.name}"! Checking follower status...`);
            }
            // --- NON-CONDITION STEP: any reply should try to advance ---
            // This handles the case where user was gated (follow prompt sent),
            // user followed and replied again. The state still points to the 
            // same step, so we just need to re-check follow status and advance.
            else if (currentStep.type === 'message' || currentStep.type === 'delay') {
              console.log(`🔄 User replied while flow paused at ${currentStep.type} step ${currentIndex} for "${campaign.name}" — re-checking follow gate`);
            } else {
              continue;
            }

            // --- Follower Check (ALWAYS runs to protect page health) ---
            {
              const followerResult = await isFollower(campaignToken, senderId);
              
              if (followerResult.status === 'no') {
                // Non-follower → send follow prompt BUT keep flow state alive!
                // Check cooldown: don't spam follow prompt if sent recently
                const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
                const { data: recentPrompts } = await supabase
                  .from('dm_logs')
                  .select('id')
                  .eq('commenter_id', senderId)
                  .eq('campaign_id', campaign.id)
                  .eq('status', 'follow_gate')
                  .gte('sent_at', fiveMinAgo)
                  .limit(1);

                if (!recentPrompts || recentPrompts.length === 0) {
                  console.log(`⏭️ User ${senderId} is NOT a follower — sending follow prompt (keeping flow state)`);
                  try {
                    const { sendDirectMessage } = require('../services/instagram');
                    await sendDirectMessage(
                      campaignToken, senderId,
                      '👋 Hey! To unlock the full content, please follow our account first. Once you follow, reply again and we\'ll send it! 📩',
                      'text_message'
                    );
                    // Log the follow gate so we can track + cooldown
                    await supabase.from('dm_logs').insert({
                      campaign_id: campaign.id,
                      commenter_id: senderId,
                      dm_message: 'Follow gate prompt sent',
                      status: 'follow_gate',
                      sent_at: new Date().toISOString(),
                    });
                  } catch (e) {
                    console.warn(`⚠️ Failed to send follow prompt:`, e.message);
                  }
                } else {
                  console.log(`⏭️ User ${senderId} is NOT a follower — follow prompt already sent recently, skipping`);
                }
                // DO NOT delete flow state — user can retry after following
                break;
              }
              
              console.log(`✅ User ${senderId} follower check passed (status: ${followerResult.status}) — advancing flow`);
            }

            // --- Advance the flow ---
            const nextStep = currentStep.type === 'condition' ? currentIndex + 1 : currentIndex;
            await advanceFlow({
              commenterId: senderId,
              campaignId: campaign.id,
              accessToken: campaignToken,
              stepIndex: nextStep,
              isUserReply: true  // User replied → 24h window is open
            });
            break;
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

        const envIgUserId = process.env.IG_USER_ID || '17841462923731141';

        // Ignore comments from the page itself to prevent infinite loops
        if (commenterId === webhookUserId || commenterId === envIgUserId) {
          console.log('⚠️  Ignoring comment from the page itself');
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

        // PRIORITY: Sort campaigns so specific_post campaigns are checked FIRST.
        // This prevents generic 'all_posts' campaigns from stealing matches
        // when a more targeted campaign exists for the specific reel.
        campaigns.sort((a, b) => {
          if (a.target_type === 'specific_post' && b.target_type !== 'specific_post') return -1;
          if (a.target_type !== 'specific_post' && b.target_type === 'specific_post') return 1;
          return 0;
        });

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

          const campaignToken = campaign.access_token || accessToken;

          // --- Send Once Per User Check (prevents spamming same user) ---
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

          // --- Page Health: Adaptive Pacing ---
          // Instead of dropping DMs when busy, we slow down the sending pace.
          // Instagram allows ~750 API calls/hour, but natural pacing is key.
          // Normal: 2-6s delay. High volume (50+ in last hour): 8-15s delay.
          const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
          const { data: recentDMs } = await supabase
            .from('dm_logs')
            .select('id')
            .eq('status', 'sent')
            .gte('sent_at', oneHourAgo);

          const dmCountLastHour = recentDMs ? recentDMs.length : 0;
          let humanDelay;
          if (dmCountLastHour >= 50) {
            // High volume — slow down significantly
            humanDelay = 8000 + Math.floor(Math.random() * 7000); // 8-15s
            console.log(`⏳ High volume (${dmCountLastHour} DMs/hr) — waiting ${humanDelay}ms (slower pacing)`);
          } else {
            // Normal volume
            humanDelay = 2000 + Math.floor(Math.random() * 4000); // 2-6s
            console.log(`⏳ Waiting ${humanDelay}ms before sending DM (natural pacing)`);
          }
          await new Promise(resolve => setTimeout(resolve, humanDelay));

          // ═══ FOLLOWER GATE — Block confirmed non-followers ═══
          // Try the follower check BEFORE sending any DM.
          // If API confirms 'no' → silently skip (protects page health).
          // If API returns 'unknown' → proceed (can't be sure, don't block legit users).
          try {
            const followerResult = await isFollower(campaignToken, commenterId);
            if (followerResult.status === 'no') {
              console.log(`🚫 BLOCKED: ${commenterId} is NOT a follower — skipping DM for "${campaign.name}" (page health protection)`);
              // Log the block so we can track it
              await supabase.from('dm_logs').insert({
                campaign_id: campaign.id,
                commenter_id: commenterId,
                comment_id: commentId || null,
                dm_message: 'BLOCKED: Non-follower, DM not sent',
                status: 'blocked_non_follower',
                sent_at: new Date().toISOString(),
              });
              continue; // Skip to next campaign (or exit loop)
            }
            console.log(`👤 Follower check for ${commenterId}: ${followerResult.status} — proceeding with DM`);
          } catch (followerErr) {
            console.warn(`⚠️ Follower check failed for ${commenterId}: ${followerErr.message} — proceeding with DM`);
          }

          // ═══ DISPATCH: Flow Builder or Standard DM ═══

          if (campaign.dm_type === 'flow_builder' && campaign.flow_data) {
            console.log(`📥 Starting flow-builder for ${commenterId} on campaign ${campaign.id}`);

            // BUG 3 FIX: Auto-reply to comment for flow_builder campaigns too
            if (campaign.auto_comment_reply !== false && commentId) {
              try {
                await replyToComment(campaignToken, commentId, 'Check your DMs! 📩');
                console.log(`✅ Auto-replied to comment ${commentId} for flow campaign`);
              } catch (replyErr) {
                console.warn(`⚠️ Failed to auto-reply to comment ${commentId}:`, replyErr.message);
              }
            }

            await advanceFlow({
              commenterId,
              campaignId: campaign.id,
              accessToken: campaignToken,
              commentId,
              stepIndex: 0
            });
            break; // CRITICAL: Only ONE campaign should fire per comment
          }

          // Default single DM handling
          console.log(`🚀 Triggering standard DM for "${campaign.name}" to commenter ${commenterId}`);
          await enqueueDM({
            commenterId,
            dmMessage: campaign.dm_message,
            type: campaign.dm_type || 'text_message',
            campaignId: campaign.id,
            accessToken: campaignToken,
            commentId,
            autoReply: campaign.auto_comment_reply !== false,
            buttonTemplateData: campaign.button_template_data,
            quickRepliesData: campaign.quick_replies_data
          });
          break; // CRITICAL: Only ONE campaign should fire per comment
        }
      }
    }
  } catch (err) {
    console.error('❌ Webhook processing error:', err.message, err.stack);
  }
});

module.exports = router;
