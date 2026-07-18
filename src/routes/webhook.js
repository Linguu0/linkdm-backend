const express = require('express');
const router = express.Router();
const supabase = require('../db/supabase');
const { matchesKeyword } = require('../services/matcher');
const { enqueueDM } = require('../services/dmQueue');
const { advanceFlow } = require('../services/flowRunner');
const { replyToComment, isFollower, getProfileUsername, sendFollowGateMessage } = require('../services/instagram');

// ---------------------------------------------------------------------------
// Rate Limiter — Prevents viral post overload (ManyChat caps at ~12/min)
// Sliding window: max 12 triggers per 60 seconds per campaign
// ---------------------------------------------------------------------------
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 60 seconds
const RATE_LIMIT_MAX = 12;              // max triggers per window
const rateLimitMap = new Map();         // campaignId -> [timestamps]

function isRateLimited(campaignId) {
  const now = Date.now();
  const windowStart = now - RATE_LIMIT_WINDOW_MS;

  if (!rateLimitMap.has(campaignId)) {
    rateLimitMap.set(campaignId, []);
  }

  const timestamps = rateLimitMap.get(campaignId);
  // Prune old entries
  while (timestamps.length > 0 && timestamps[0] < windowStart) {
    timestamps.shift();
  }

  if (timestamps.length >= RATE_LIMIT_MAX) {
    return true; // Rate limited
  }

  timestamps.push(now);
  return false;
}

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
          const text = msg.message?.text || msg.postback?.title || msg.message?.quick_reply?.payload || msg.postback?.payload;
          const isPostback = !!msg.postback;
          const postbackPayload = msg.postback?.payload;

          console.log(`📨 DM event — senderId=${senderId}, text="${text}", isPostback=${isPostback}, payload=${postbackPayload || 'none'}`);

          if (!senderId || !text) continue;

          console.log(`💬 Received DM from ${senderId}: "${text}"`);

          // Find ALL active flow sessions for this user
          // Order by most recently updated — the user is most likely replying
          // to the campaign they interacted with last
          const { data: states, error: stateError } = await supabase
            .from('user_flow_states')
            .select('*, campaigns(*)')
            .eq('commenter_id', senderId)
            .order('last_updated_at', { ascending: false });

          if (stateError || !states || states.length === 0) {
            console.log(`ℹ️ No active flow state for ${senderId}`);
            continue;
          }

          console.log(`🔄 User ${senderId} has ${states.length} active flow(s):`);
          
          // Clean up stale flow states (older than 24h — IG DM window expires)
          const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
          const freshStates = [];
          for (const s of states) {
            if (s.last_updated_at && s.last_updated_at < twentyFourHoursAgo) {
              console.log(`🗑️ Cleaning up stale flow state for campaign ${s.campaign_id} (last updated: ${s.last_updated_at})`);
              await supabase.from('user_flow_states').delete()
                .eq('commenter_id', senderId)
                .eq('campaign_id', s.campaign_id);
            } else {
              console.log(`  → Campaign "${s.campaigns?.name}" (step: ${s.current_step_index}, updated: ${s.last_updated_at})`);
              freshStates.push(s);
            }
          }

          if (freshStates.length === 0) {
            console.log(`ℹ️ All flow states were stale for ${senderId}`);
            continue;
          }

          // Process the MOST RECENT flow state first (already sorted by last_updated_at DESC)
          for (const state of freshStates) {
            const campaign = state.campaigns;
            if (!campaign) continue;

            const currentIndex = state.current_step_index;
            const campaignToken = campaign.access_token || process.env.ACCESS_TOKEN;

            // ═══ SPECIAL: Standard DM waiting for reply (current_step_index === -1) ═══
            // This means the campaign is a standard DM (not flow_builder) that was
            // converted to a 2-step flow. The teaser was sent, user replied → now
            // check follower status and send the actual content.
            if (currentIndex === -1) {
              console.log(`📨 Standard DM reply received from ${senderId} for "${campaign.name}" — checking follower status`);

              // Check follower status — only block definitively confirmed non-followers
              console.log(`🔍 [StdDM] Checking follower for ${senderId} with token: ${campaignToken ? campaignToken.substring(0, 10) + '...' : 'MISSING!'}`);
              const followerResult = await isFollower(campaignToken, senderId);
              console.log(`🔍 [StdDM] Result: status="${followerResult.status}", reason="${followerResult.reason || 'none'}"`);

              if (followerResult.status === 'no') {
                console.log(`🚫 User ${senderId} confirmed NOT a follower — SKIPPING DM`);
                break;
              }

              // ONLY confirmed followers reach here
              console.log(`✅ CONFIRMED follower — sending actual content for "${campaign.name}"`);
              await enqueueDM({
                commenterId: senderId,
                dmMessage: campaign.dm_message,
                type: campaign.dm_type || 'text_message',
                campaignId: campaign.id,
                accessToken: campaignToken,
                commentId: null,  // Use recipient.id, not comment_id (window is open)
                autoReply: false,
                buttonTemplateData: campaign.button_template_data,
                quickRepliesData: campaign.quick_replies_data
              });

              // Clean up flow state — content delivered
              await supabase.from('user_flow_states').delete()
                .eq('commenter_id', senderId)
                .eq('campaign_id', campaign.id);
              break;
            }

            // ═══ FOLLOW GATE: User tapped "I'm following ✅" (step -2) ═══
            if (currentIndex === -2) {
              console.log(`🔒 Follow gate response from ${senderId} for "${campaign.name}" — checking follower status...`);

              const followerResult = await isFollower(campaignToken, senderId);
              console.log(`🔍 Follow gate result for ${senderId}: status="${followerResult.status}", reason="${followerResult.reason || 'none'}"`);

              if (followerResult.status === 'no') {
                // ❌ DEFINITIVELY not a follower — resend follow gate
                console.log(`❌ ${senderId} confirmed NOT a follower — resending follow gate`);
                const profileUsername = await getProfileUsername(campaignToken);
                const profileUrl = profileUsername ? `https://www.instagram.com/${profileUsername}` : 'https://www.instagram.com/';

                try {
                  await sendFollowGateMessage(campaignToken, senderId, null, profileUrl);
                } catch (gateErr) {
                  console.error(`❌ Failed to resend follow gate:`, gateErr.message);
                }

                // Update timestamp to keep state fresh
                await supabase.from('user_flow_states')
                  .update({ last_updated_at: new Date().toISOString() })
                  .eq('commenter_id', senderId)
                  .eq('campaign_id', campaign.id);
              } else {
                // ✅ Follower confirmed ('yes') OR API can't verify ('unknown'/Error 230)
                // In both cases, send the content. The user clicked "I'm following",
                // and the API error shouldn't trap them in an infinite loop.
                console.log(`✅ Sending content for "${campaign.name}" (follower status: ${followerResult.status})`);

                const btnData = typeof campaign.button_template_data === 'string' ? JSON.parse(campaign.button_template_data) : campaign.button_template_data;
                const qrData = typeof campaign.quick_replies_data === 'string' ? JSON.parse(campaign.quick_replies_data) : campaign.quick_replies_data;

                if (campaign.dm_type === 'flow_builder' && campaign.flow_data) {
                  await advanceFlow({
                    commenterId: senderId,
                    campaignId: campaign.id,
                    accessToken: campaignToken,
                    commentId: null,
                    stepIndex: 0
                  });
                } else {
                  await enqueueDM({
                    commenterId: senderId,
                    dmMessage: campaign.dm_message,
                    type: campaign.dm_type || 'text_message',
                    campaignId: campaign.id,
                    accessToken: campaignToken,
                    commentId: null,
                    autoReply: false,
                    buttonTemplateData: btnData,
                    quickRepliesData: qrData
                  });
                }

                // Clean up flow state — but NOT for flow_builder!
                // advanceFlow manages its own state (it just saved step 1 waiting for reply).
                // Deleting it here would wipe out the state advanceFlow just created.
                if (campaign.dm_type !== 'flow_builder') {
                  await supabase.from('user_flow_states').delete()
                    .eq('commenter_id', senderId)
                    .eq('campaign_id', campaign.id);
                }

                await supabase.from('dm_logs').insert({
                  campaign_id: campaign.id,
                  commenter_id: senderId,
                  dm_message: `[FOLLOW GATE PASSED] Content sent for "${campaign.name}" (status: ${followerResult.status})`,
                  status: 'sent',
                  sent_at: new Date().toISOString()
                });
              }
              break;
            }

            // ═══ Flow Builder campaigns ═══
            const flow = typeof campaign.flow_data === 'string' ? JSON.parse(campaign.flow_data) : campaign.flow_data;
            if (!flow || !flow.steps) continue;

            const currentStep = flow.steps[currentIndex];

            // If flow is past the end or no step exists, clean up
            if (!currentStep) {
              await supabase.from('user_flow_states').delete()
                .eq('commenter_id', senderId)
                .eq('campaign_id', campaign.id);
              continue;
            }


            // --- CONDITION STEP: check keyword match ---
            if (currentStep.type === 'condition') {
              console.log(`🔎 Checking condition for campaign "${campaign.name}" at step ${currentIndex}`);

              const keywords = (currentStep.matchKeywords || '').split(',').map(k => k.trim().toLowerCase()).filter(Boolean);
              const isMatch = keywords.length === 0 || keywords.some(k => text.toLowerCase().includes(k));

              if (!isMatch) {
                // Keywords didn't match — BUT if user was previously follow-gated,
                // they might be replying "Done", "kar diya", "Following" etc.
                // In that case, accept ANY reply and just re-check follower status.
                const { data: gateLog } = await supabase
                  .from('dm_logs')
                  .select('id')
                  .eq('commenter_id', senderId)
                  .eq('campaign_id', campaign.id)
                  .eq('status', 'follow_gate')
                  .limit(1);

                if (gateLog && gateLog.length > 0) {
                  console.log(`🔓 User ${senderId} was previously follow-gated — accepting ANY reply for "${campaign.name}"`);
                  // Fall through to follower check below
                } else {
                  continue; // Genuine keyword mismatch, skip
                }
              } else {
                console.log(`✅ Condition match for campaign "${campaign.name}"! Checking follower status...`);
              }
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

            // --- Follower Check — only block definitively confirmed non-followers ---
            {
              console.log(`🔍 Checking follower status for ${senderId} with token: ${campaignToken ? campaignToken.substring(0, 10) + '...' : 'MISSING!'}`);
              const followerResult = await isFollower(campaignToken, senderId);
              console.log(`🔍 Follower check result for ${senderId}: status="${followerResult.status}", reason="${followerResult.reason || 'none'}"`);
              
              if (followerResult.status === 'no') {
                // Only block if API definitively says NOT a follower
                console.log(`🚫 User ${senderId} is confirmed NOT a follower — SKIPPING DM`);
                break;
              }
              
              // 'yes' or 'unknown' (API error) — proceed with content delivery
              console.log(`✅ User ${senderId} — proceeding with flow (follower status: ${followerResult.status})`);
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
        const { data: pageUser } = await supabase.from('users').select('access_token').eq('ig_user_id', webhookUserId).single();
        accessToken = pageUser?.access_token;
        if (!accessToken && campaigns.length > 0) {
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
            // Instagram webhook sends 17-char media IDs, but dashboard may store
            // 15-char or 17-char IDs. Use bidirectional includes() to match either way.
            const isTargetMatch = mediaId === campaign.target_media_id ||
                                 mediaId.includes(campaign.target_media_id) ||
                                 campaign.target_media_id.includes(mediaId);

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

          // --- Rate Limiter (ManyChat-style: ~12 triggers/min per campaign) ---
          if (isRateLimited(campaign.id)) {
            console.log(`⏳ Rate limited for "${campaign.name}" — queueing with extra delay`);
            // Don't skip — add a longer delay instead so no user is dropped
            await new Promise(resolve => setTimeout(resolve, 5000 + Math.floor(Math.random() * 5000)));
          }

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
          // IMPORTANT: Exclude 'follow_gate' status — a follow gate is NOT a delivered DM.
          // Without this exclusion, users who received the follow gate would be
          // permanently blocked from ever getting the actual content.
          let shouldSkip = false;
          if (campaign.send_once_per_user !== false) {
            const { data: existingLogs, error: logError } = await supabase
              .from('dm_logs')
              .select('id')
              .eq('campaign_id', campaign.id)
              .eq('commenter_id', commenterId)
              .neq('status', 'debug')
              .neq('status', 'follow_gate')
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

          // ═══ COMPETITOR-STYLE FOLLOW GATE ═══
          // Step 1: Check follower status FIRST (if they've messaged before, this works instantly).
          // Step 2: If 'yes' → send link instantly.
          // Step 3: If 'no' or 'unknown' (Error 230 because no prior DM) → send Follow Gate.
          console.log(`🔍 Checking follower status for ${commenterId} before sending follow gate...`);
          const followerResult = await isFollower(campaignToken, commenterId);
          console.log(`🔍 Follower result for ${commenterId}: status="${followerResult.status}", reason="${followerResult.reason || 'none'}"`);

          // Auto-reply to comment (RANDOMIZED to avoid spam detection — ManyChat best practice)
          if (campaign.auto_comment_reply !== false && commentId) {
            const replyVariations = [
              'Check your DMs! 📩',
              'Sent you a message! 💬',
              'DM sent! Check your inbox 📬',
              'Just sent it to your DMs! ✅',
              'Check your messages! 📨',
              'Sent! Look in your DMs 💌',
              'DM bhej diya! Check karo 📩',
              'Message sent! ✨'
            ];
            const randomReply = replyVariations[Math.floor(Math.random() * replyVariations.length)];
            try {
              await replyToComment(campaignToken, commentId, randomReply);
              console.log(`✅ Auto-replied to comment ${commentId}: "${randomReply}"`);
            } catch (replyErr) {
              console.warn(`⚠️ Failed to auto-reply to comment ${commentId}:`, replyErr.message);
            }
          }

          if (followerResult.status === 'yes') {
            // ✅ Already a confirmed follower (and API allowed the check)
            console.log(`✅ User ${commenterId} is a CONFIRMED follower — sending actual content directly`);
            
            if (campaign.dm_type === 'flow_builder' && campaign.flow_data) {
              console.log(`📥 Starting flow-builder for ${commenterId} on campaign ${campaign.id}`);
              await advanceFlow({
                commenterId,
                campaignId: campaign.id,
                accessToken: campaignToken,
                commentId,
                stepIndex: 0
              });
            } else {
              const btnData = typeof campaign.button_template_data === 'string' ? JSON.parse(campaign.button_template_data) : campaign.button_template_data;
              const qrData = typeof campaign.quick_replies_data === 'string' ? JSON.parse(campaign.quick_replies_data) : campaign.quick_replies_data;

              await enqueueDM({
                commenterId,
                dmMessage: campaign.dm_message,
                type: campaign.dm_type || 'text_message',
                campaignId: campaign.id,
                accessToken: campaignToken,
                commentId,
                autoReply: false,
                buttonTemplateData: btnData,
                quickRepliesData: qrData
              });
            }
          } else {
            // ❌ Not a follower OR Unknown (Error 230) — Send Follow Gate
            console.log(`🔒 User ${commenterId} status is ${followerResult.status} — sending follow gate for "${campaign.name}"`);
            const profileUsername = await getProfileUsername(campaignToken);
            const profileUrl = profileUsername ? `https://www.instagram.com/${profileUsername}` : 'https://www.instagram.com/';

            try {
              // Send follow gate message via private reply (comment_id)
              await sendFollowGateMessage(campaignToken, commenterId, commentId, profileUrl);

              // Save flow state with step -2 (follow gate pending)
              await supabase.from('user_flow_states').upsert({
                commenter_id: commenterId,
                campaign_id: campaign.id,
                current_step_index: -2,
                last_updated_at: new Date().toISOString()
              }, { onConflict: 'commenter_id,campaign_id' });

              // Log the follow gate
              await supabase.from('dm_logs').insert({
                campaign_id: campaign.id,
                commenter_id: commenterId,
                comment_id: commentId,
                dm_message: `[FOLLOW GATE] Sent follow check for "${campaign.name}"`,
                status: 'follow_gate',
                sent_at: new Date().toISOString()
              });

              console.log(`✅ Follow gate sent and flow state saved for ${commenterId}`);
            } catch (gateErr) {
              console.error(`❌ Failed to send follow gate to ${commenterId}:`, gateErr.message);
            }
          }
          break;
        }
      }
    }
  } catch (err) {
    console.error('❌ Webhook processing error:', err.message, err.stack);
  }
});

module.exports = router;
