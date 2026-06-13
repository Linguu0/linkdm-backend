const supabase = require('../db/supabase');
const { enqueueDM } = require('./dmQueue');
const { replyToComment } = require('./instagram');

/**
 * flowRunner.js — Active Flow Execution Service
 * 
 * Handles advancing users through multi-step automation flows.
 * 
 * IMPORTANT — Instagram API Limitation:
 * A private reply (comment_id) only allows ONE message per comment.
 * The 24-hour DM window does NOT open from a private reply — only when 
 * the USER replies back. So for flows without a condition step (user reply),
 * all messages before the first condition must be MERGED into a single DM.
 * 
 * For flows WITH a condition step, the condition waits for user reply,
 * which opens the 24-hour window for follow-up messages.
 */

/**
 * Collects all consecutive message steps (skipping delays) until a condition
 * step or end of flow. These messages must be sent as ONE combined DM since
 * Instagram only allows one private reply per comment.
 * 
 * @param {Array} steps - The flow steps array
 * @param {number} startIndex - Index to start collecting from
 * @returns {{ messages: string[], nextActionIndex: number }}
 */
function collectMessagesUntilCondition(steps, startIndex) {
  const messages = [];
  let i = startIndex;

  while (i < steps.length) {
    const step = steps[i];

    if (step.type === 'message') {
      messages.push(step.text);
      i++;
    } else if (step.type === 'delay') {
      // Skip delays — we can't actually delay between DMs without 
      // the user replying first (Instagram API limitation)
      i++;
    } else if (step.type === 'condition') {
      // Stop here — condition waits for user input
      break;
    } else {
      i++;
    }
  }

  return { messages, nextActionIndex: i };
}

/**
 * Advances a flow for a user.
 * 
 * @param {object} params
 * @param {string} params.commenterId - IGSID of the user
 * @param {string} params.campaignId - UUID of the campaign
 * @param {string} params.accessToken - IG Access Token
 * @param {number} [params.stepIndex] - Optional index to jump to
 * @param {string} [params.commentId] - Optional comment ID for private replies
 * @param {boolean} [params.isUserReply] - True if triggered by user DM reply (window is open)
 */
async function advanceFlow({ commenterId, campaignId, accessToken, stepIndex = null, commentId = null, isUserReply = false }) {
  console.log(`[FlowRunner] Advancing flow for ${commenterId} (campaign: ${campaignId}, stepIndex: ${stepIndex}, isUserReply: ${isUserReply})`);

  // 1. Fetch campaign and current state
  const { data: campaign, error: campErr } = await supabase
    .from('campaigns')
    .select('*')
    .eq('id', campaignId)
    .single();

  if (campErr || !campaign) {
    console.error(`[FlowRunner] Campaign ${campaignId} not found`);
    return;
  }

  const flow = typeof campaign.flow_data === 'string' ? JSON.parse(campaign.flow_data) : campaign.flow_data;
  if (!flow || !flow.steps || !Array.isArray(flow.steps)) {
    console.warn(`[FlowRunner] No valid flow steps for campaign ${campaignId}`);
    return;
  }

  // 2. Determine which step to process
  let currentIndex = stepIndex;
  
  if (currentIndex === null) {
    const { data: state, error: stateErr } = await supabase
      .from('user_flow_states')
      .select('current_step_index')
      .eq('commenter_id', commenterId)
      .eq('campaign_id', campaignId)
      .single();
    
    currentIndex = state ? state.current_step_index : 0;
  }

  const currentStep = flow.steps[currentIndex];
  if (!currentStep) {
    console.log(`[FlowRunner] Flow ended for ${commenterId} (no step at index ${currentIndex})`);
    // Clean up flow state when flow completes
    await supabase.from('user_flow_states').delete().eq('commenter_id', commenterId).eq('campaign_id', campaignId);
    return;
  }

  console.log(`[FlowRunner] Processing step ${currentIndex}: ${currentStep.type} (total steps: ${flow.steps.length})`);

  // ═══════════════════════════════════════════════════════════════════════
  // CASE 1: First trigger from comment (no user reply yet)
  //         Only send the FIRST message. Remaining steps require user reply
  //         so the follower check in Section A can gate the content.
  // ═══════════════════════════════════════════════════════════════════════
  if (currentIndex === 0 && !isUserReply) {
    // Only collect the first message (not all messages before condition)
    const firstMessage = flow.steps[0];
    
    if (!firstMessage || firstMessage.type !== 'message') {
      console.warn(`[FlowRunner] First step is not a message for campaign ${campaignId}`);
      return;
    }

    // Find what comes after the first message (skip delays)
    let nextActionIndex = 1;
    while (nextActionIndex < flow.steps.length && flow.steps[nextActionIndex].type === 'delay') {
      nextActionIndex++;
    }

    console.log(`[FlowRunner] 📦 Sending ONLY first message (step 0). Remaining ${flow.steps.length - 1} step(s) wait for reply.`);

    // Update flow state to the next action point
    await supabase.from('user_flow_states').upsert({
      commenter_id: commenterId,
      campaign_id: campaignId,
      current_step_index: nextActionIndex,
      last_updated_at: new Date().toISOString()
    }, { onConflict: 'commenter_id, campaign_id' });

    // Send ONLY the first message as private reply
    await enqueueDM({
      commenterId,
      dmMessage: firstMessage.text,
      type: firstMessage.messageType || 'text_message',
      campaignId: campaign.id,
      accessToken,
      commentId: commentId,  // Use comment_id for private reply
      autoReply: false,
      buttonTemplateData: firstMessage.buttonTemplateData || null,
      quickRepliesData: firstMessage.quickRepliesData || null
    });

    // If next action is a condition, we stop and wait for user reply
    if (nextActionIndex < flow.steps.length && flow.steps[nextActionIndex].type === 'condition') {
      console.log(`[FlowRunner] ⏸️ Flow paused at condition step ${nextActionIndex}, waiting for user reply`);
      return;
    }

    // If there are MORE steps after the first message (no condition), 
    // still wait for reply — the follower check in Section A will gate content
    if (nextActionIndex < flow.steps.length) {
      console.log(`[FlowRunner] ⏸️ Flow paused at step ${nextActionIndex} — waiting for user reply to check follower status`);
      return;
    }

    // If we've reached the end (single-message flow), clean up
    if (nextActionIndex >= flow.steps.length) {
      console.log(`[FlowRunner] ✅ Flow completed for ${commenterId} (single message flow)`);
      return;
    }

    return;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // CASE 2: User replied (condition matched) — 24h window is now OPEN
  //         Can send individual messages with actual delays
  // ═══════════════════════════════════════════════════════════════════════
  if (currentStep.type === 'message') {
    const nextIndex = currentIndex + 1;

    // Update state
    await supabase.from('user_flow_states').upsert({
      commenter_id: commenterId,
      campaign_id: campaignId,
      current_step_index: nextIndex,
      last_updated_at: new Date().toISOString()
    }, { onConflict: 'commenter_id, campaign_id' });

    console.log(`[FlowRunner] Message step (window open): Sending DM, moving to index ${nextIndex}`);

    // Send message using recipient.id (window is open from user reply)
    await enqueueDM({
      commenterId,
      dmMessage: currentStep.text,
      type: currentStep.messageType || 'text_message',
      campaignId: campaign.id,
      accessToken,
      commentId: null,  // Don't use comment_id — use recipient.id
      autoReply: false,
      buttonTemplateData: currentStep.buttonTemplateData || null,
      quickRepliesData: currentStep.quickRepliesData || null
    });

    // Continue to next step
    return advanceFlow({ commenterId, campaignId, accessToken, stepIndex: nextIndex, isUserReply: true });

  } else if (currentStep.type === 'delay') {
    const delayMs = calculateDelay(currentStep);
    const nextIndex = currentIndex + 1;
    const fireAt = new Date(Date.now() + delayMs).toISOString();

    console.log(`[FlowRunner] Delay step (window open): ${delayMs}ms delay, fire_at: ${fireAt}`);

    // Update flow state
    await supabase.from('user_flow_states').upsert({
      commenter_id: commenterId,
      campaign_id: campaignId,
      current_step_index: nextIndex,
      last_updated_at: new Date().toISOString()
    }, { onConflict: 'commenter_id, campaign_id' });

    // Store delay in Supabase for reliable execution
    const { error: delayErr } = await supabase.from('pending_delays').insert({
      commenter_id: commenterId,
      campaign_id: campaignId,
      access_token: accessToken,
      next_step_index: nextIndex,
      fire_at: fireAt,
      status: 'pending'
    });

    if (delayErr) {
      console.error(`[FlowRunner] ❌ Failed to store pending delay:`, delayErr.message);
    } else {
      console.log(`[FlowRunner] ✅ Delay stored in DB. Will fire at ${fireAt}`);
    }

  } else if (currentStep.type === 'condition') {
    // Wait for user input
    console.log(`[FlowRunner] Condition step: Waiting for user input at index ${currentIndex}`);
    await supabase.from('user_flow_states').upsert({
      commenter_id: commenterId,
      campaign_id: campaignId,
      current_step_index: currentIndex,
      last_updated_at: new Date().toISOString()
    }, { onConflict: 'commenter_id, campaign_id' });
  }
}

/**
 * Polls `pending_delays` table for any delays that are due.
 * Called on an interval from app.js.
 */
async function processPendingDelays() {
  const now = new Date().toISOString();

  const { data: dueDelays, error } = await supabase
    .from('pending_delays')
    .select('*')
    .eq('status', 'pending')
    .lte('fire_at', now)
    .order('fire_at', { ascending: true })
    .limit(20);

  if (error) {
    console.error('[DelayPoller] ❌ Error fetching pending delays:', error.message);
    return;
  }

  if (!dueDelays || dueDelays.length === 0) return;

  console.log(`[DelayPoller] ⏰ Found ${dueDelays.length} due delay(s), processing...`);

  for (const delay of dueDelays) {
    try {
      // Mark as processing to prevent duplicates
      const { data: updated, error: updateErr } = await supabase
        .from('pending_delays')
        .update({ status: 'processing' })
        .eq('id', delay.id)
        .eq('status', 'pending')
        .select();

      if (updateErr || !updated || updated.length === 0) {
        console.log(`[DelayPoller] Skipping delay ${delay.id} — already picked up`);
        continue;
      }

      console.log(`[DelayPoller] 🚀 Firing delay for ${delay.commenter_id} → step ${delay.next_step_index}`);

      await advanceFlow({
        commenterId: delay.commenter_id,
        campaignId: delay.campaign_id,
        accessToken: delay.access_token,
        stepIndex: delay.next_step_index,
        isUserReply: true  // Delays only happen after user replied (window open)
      });

      await supabase
        .from('pending_delays')
        .update({ status: 'completed' })
        .eq('id', delay.id);

      console.log(`[DelayPoller] ✅ Delay ${delay.id} completed`);

    } catch (err) {
      console.error(`[DelayPoller] ❌ Failed to process delay ${delay.id}:`, err.message);
      await supabase
        .from('pending_delays')
        .update({ status: 'failed' })
        .eq('id', delay.id);
    }
  }
}

/**
 * Calculates delay in milliseconds based on step data.
 */
function calculateDelay(step) {
  const duration = parseInt(step.duration) || 0;
  const unit = step.unit || 'seconds';
  
  switch (unit) {
    case 'seconds': return duration * 1000;
    case 'minutes': return duration * 60 * 1000;
    case 'hours': return duration * 60 * 60 * 1000;
    default: return duration * 1000;
  }
}

module.exports = { advanceFlow, processPendingDelays };
