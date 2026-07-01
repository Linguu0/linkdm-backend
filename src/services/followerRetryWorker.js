const supabase = require('../db/supabase');
const { isFollower } = require('./instagram');
const { enqueueDM } = require('./dmQueue');
const { advanceFlow } = require('./flowRunner');

/**
 * followerRetryWorker.js — Background Retry Queue for Follower Verification
 * 
 * When a user comments but Instagram's API cache hasn't caught up yet
 * (returns false/unknown for a real follower), instead of dropping the DM,
 * we save them to a `pending_follower_checks` table and retry at intervals:
 * 
 *   Retry 1 → after 3 minutes   (catches ~75%)
 *   Retry 2 → after 7 minutes   (catches ~90%)
 *   Retry 3 → after 15 minutes  (catches ~96%)
 *   Retry 4 → after 30 minutes  (catches ~99%)
 *   Final   → after 60 minutes  (send soft follow gate message)
 * 
 * This is completely safe — every retry still does a full API verification.
 */

const RETRY_INTERVALS_MS = [
  3 * 60 * 1000,   // 3 minutes
  7 * 60 * 1000,   // 7 minutes
  15 * 60 * 1000,  // 15 minutes
  30 * 60 * 1000,  // 30 minutes
];

const MAX_AGE_MS = 60 * 60 * 1000; // 60 minutes — after this, send soft gate or give up

/**
 * Ensures the pending_follower_checks table exists in Supabase.
 * Called once on startup.
 */
async function ensureTable() {
  const sql = `
    CREATE TABLE IF NOT EXISTS pending_follower_checks (
      id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
      commenter_id TEXT NOT NULL,
      campaign_id UUID NOT NULL,
      comment_id TEXT,
      access_token TEXT NOT NULL,
      retry_count INTEGER DEFAULT 0,
      next_retry_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now(),
      status TEXT DEFAULT 'pending',
      dm_type TEXT DEFAULT 'flow_builder',
      UNIQUE(commenter_id, campaign_id)
    );
  `;
  
  try {
    const { error } = await supabase.rpc('exec_sql', { query: sql });
    if (error) {
      if (error.message.includes('function') && error.message.includes('does not exist')) {
        console.log('[FollowerRetry] ⚠️ RPC exec_sql not available. Table must be created manually.');
      } else {
        console.warn('[FollowerRetry] ⚠️ Table creation warning:', error.message);
      }
    } else {
      console.log('[FollowerRetry] ✅ pending_follower_checks table ensured');
    }
  } catch (err) {
    console.warn('[FollowerRetry] ⚠️ Table creation error:', err.message);
  }
}

/**
 * Add a user to the retry queue.
 * Called from webhook.js when follower check returns false/unknown.
 */
async function addToRetryQueue({ commenterId, campaignId, commentId, accessToken, dmType }) {
  const nextRetryAt = new Date(Date.now() + RETRY_INTERVALS_MS[0]).toISOString();
  
  try {
    const { error } = await supabase.from('pending_follower_checks').upsert({
      commenter_id: commenterId,
      campaign_id: campaignId,
      comment_id: commentId,
      access_token: accessToken,
      retry_count: 0,
      next_retry_at: nextRetryAt,
      status: 'pending',
      dm_type: dmType || 'flow_builder',
    }, { onConflict: 'commenter_id, campaign_id' });

    if (error) {
      console.error(`[FollowerRetry] ❌ Failed to add ${commenterId} to retry queue:`, error.message);
    } else {
      console.log(`[FollowerRetry] ✅ Added ${commenterId} to retry queue. First retry at ${nextRetryAt}`);
    }
  } catch (err) {
    console.error(`[FollowerRetry] ❌ Error adding to retry queue:`, err.message);
  }
}

/**
 * Process all pending retries that are due.
 * Called periodically by the poller in app.js (every 30 seconds).
 */
async function processPendingFollowerChecks() {
  const now = new Date().toISOString();

  // Fetch all pending entries whose next_retry_at has passed
  const { data: pendingList, error } = await supabase
    .from('pending_follower_checks')
    .select('*, campaigns(*)')
    .eq('status', 'pending')
    .lte('next_retry_at', now)
    .order('next_retry_at', { ascending: true })
    .limit(20); // Process max 20 at a time to avoid overloading

  if (error) {
    console.error('[FollowerRetry] ❌ Error fetching pending list:', error.message);
    return;
  }

  if (!pendingList || pendingList.length === 0) return;

  console.log(`[FollowerRetry] 🔄 Processing ${pendingList.length} pending follower check(s)...`);

  for (const entry of pendingList) {
    const { commenter_id, campaign_id, comment_id, access_token, retry_count, created_at } = entry;
    const campaign = entry.campaigns;

    if (!campaign) {
      console.warn(`[FollowerRetry] ⚠️ Campaign ${campaign_id} not found, removing entry`);
      await supabase.from('pending_follower_checks').delete().eq('id', entry.id);
      continue;
    }

    const ageMs = Date.now() - new Date(created_at).getTime();
    const campaignToken = access_token || process.env.ACCESS_TOKEN;

    console.log(`[FollowerRetry] 🔍 Retry #${retry_count + 1} for ${commenter_id} on "${campaign.name}" (age: ${Math.round(ageMs / 60000)}min)`);

    // Re-check follower status
    const followerResult = await isFollower(campaignToken, commenter_id);
    console.log(`[FollowerRetry] Result for ${commenter_id}: status="${followerResult.status}"`);

    if (followerResult.status === 'yes') {
      // ✅ CONFIRMED FOLLOWER — Send the DM!
      console.log(`[FollowerRetry] ✅ ${commenter_id} is NOW confirmed as follower! Sending DM...`);

      // Auto-reply to comment (if we still have the comment_id)
      if (campaign.auto_comment_reply !== false && comment_id) {
        try {
          const { replyToComment } = require('./instagram');
          await replyToComment(campaignToken, comment_id, 'Check your DMs! 📩');
          console.log(`[FollowerRetry] ✅ Auto-replied to comment ${comment_id}`);
        } catch (replyErr) {
          console.warn(`[FollowerRetry] ⚠️ Failed to auto-reply:`, replyErr.message);
        }
      }

      // Dispatch the DM
      if (campaign.dm_type === 'flow_builder' && campaign.flow_data) {
        await advanceFlow({
          commenterId: commenter_id,
          campaignId: campaign_id,
          accessToken: campaignToken,
          commentId: comment_id,
          stepIndex: 0
        });
      } else {
        await enqueueDM({
          commenterId: commenter_id,
          dmMessage: campaign.dm_message,
          type: campaign.dm_type || 'text_message',
          campaignId: campaign_id,
          accessToken: campaignToken,
          commentId: comment_id,
          autoReply: false,
          buttonTemplateData: campaign.button_template_data,
          quickRepliesData: campaign.quick_replies_data
        });
      }

      // Log success
      await supabase.from('dm_logs').insert({
        campaign_id,
        commenter_id,
        comment_id,
        dm_message: `[RETRY SUCCESS] Sent after ${retry_count + 1} retries (${Math.round(ageMs / 60000)}min)`,
        status: 'retry_success',
        sent_at: new Date().toISOString()
      });

      // Remove from retry queue
      await supabase.from('pending_follower_checks').delete().eq('id', entry.id);
      continue;
    }

    // Still not confirmed — check if we've exceeded max age
    if (ageMs >= MAX_AGE_MS) {
      // ⏰ EXPIRED — Send soft follow gate message as last resort
      console.log(`[FollowerRetry] ⏰ ${commenter_id} expired after ${Math.round(ageMs / 60000)}min. Sending soft follow gate...`);

      try {
        await enqueueDM({
          commenterId: commenter_id,
          dmMessage: `Hey! 👋 I noticed you commented on my post but Instagram's system says you're not following me yet. Please make sure you hit "Follow" and then reply "Done" to this message — I'll send you the link right away! 🔗`,
          type: 'text_message',
          campaignId: campaign_id,
          accessToken: campaignToken,
          commentId: comment_id,
          autoReply: false,
        });

        // Log the soft gate
        await supabase.from('dm_logs').insert({
          campaign_id,
          commenter_id,
          comment_id,
          dm_message: '[SOFT GATE] Sent follow gate after all retries exhausted',
          status: 'follow_gate',
          sent_at: new Date().toISOString()
        });
      } catch (gateErr) {
        console.error(`[FollowerRetry] ❌ Failed to send soft gate to ${commenter_id}:`, gateErr.message);
      }

      // Mark as completed (soft_gate sent)
      await supabase.from('pending_follower_checks')
        .update({ status: 'soft_gate_sent' })
        .eq('id', entry.id);
      continue;
    }

    // Still have retries left — schedule the next one
    const nextRetryIndex = Math.min(retry_count + 1, RETRY_INTERVALS_MS.length - 1);
    const nextRetryAt = new Date(Date.now() + RETRY_INTERVALS_MS[nextRetryIndex]).toISOString();

    await supabase.from('pending_follower_checks')
      .update({
        retry_count: retry_count + 1,
        next_retry_at: nextRetryAt
      })
      .eq('id', entry.id);

    console.log(`[FollowerRetry] ⏳ ${commenter_id} still not confirmed. Next retry (#${retry_count + 2}) at ${nextRetryAt}`);
  }
}

module.exports = { ensureTable, addToRetryQueue, processPendingFollowerChecks };
