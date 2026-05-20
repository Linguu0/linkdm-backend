const supabase = require('../db/supabase');
const { enqueueDM } = require('./dmQueue');
const { replyToComment } = require('./instagram');

/**
 * flowRunner.js — Active Flow Execution Service
 * 
 * Handles advancing users through multi-step automation flows.
 * Uses Supabase `pending_delays` table for reliable delay persistence
 * (survives Render spin-downs and server restarts).
 */

/**
 * Advances a flow for a user.
 * 
 * @param {object} params
 * @param {string} params.commenterId - IGSID of the user
 * @param {string} params.campaignId - UUID of the campaign
 * @param {string} params.accessToken - IG Access Token
 * @param {number} [params.stepIndex] - Optional index to jump to
 * @param {string} [params.commentId] - Optional comment ID for private replies
 */
async function advanceFlow({ commenterId, campaignId, accessToken, stepIndex = null, commentId = null }) {
  console.log(`[FlowRunner] Advancing flow for ${commenterId} (campaign: ${campaignId}, stepIndex: ${stepIndex})`);

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

  // 3. Handle step types
  if (currentStep.type === 'message') {
    const nextIndex = currentIndex + 1;

    // A. Update state BEFORE sending to avoid race conditions
    await supabase.from('user_flow_states').upsert({
      commenter_id: commenterId,
      campaign_id: campaignId,
      current_step_index: nextIndex,
      last_updated_at: new Date().toISOString()
    }, { onConflict: 'commenter_id, campaign_id' });

    console.log(`[FlowRunner] Message step: Enqueuing DM and moving to index ${nextIndex}`);

    // B. Send message
    await enqueueDM({
      commenterId,
      dmMessage: currentStep.text,
      type: currentStep.messageType || 'text_message',
      campaignId: campaign.id,
      accessToken,
      commentId: currentIndex === 0 ? commentId : null,
      // Auto-reply is handled in webhook.js now (BUG 3 FIX), don't duplicate
      autoReply: false,
      buttonTemplateData: currentStep.buttonTemplateData || null,
      quickRepliesData: currentStep.quickRepliesData || null
    });

    // C. Move to next step automatically
    return advanceFlow({ commenterId, campaignId, accessToken, stepIndex: nextIndex, commentId });

  } else if (currentStep.type === 'delay') {
    const delayMs = calculateDelay(currentStep);
    const nextIndex = currentIndex + 1;
    const fireAt = new Date(Date.now() + delayMs).toISOString();

    console.log(`[FlowRunner] Delay step: ${delayMs}ms delay, next step ${nextIndex}, fire_at: ${fireAt}`);

    // Update flow state to the step AFTER the delay
    await supabase.from('user_flow_states').upsert({
      commenter_id: commenterId,
      campaign_id: campaignId,
      current_step_index: nextIndex,
      last_updated_at: new Date().toISOString()
    }, { onConflict: 'commenter_id, campaign_id' });

    // Store delay in Supabase — survives server restarts & Render spin-downs
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
    // Wait for user input. Save current index as the active step.
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
 * This is the core reliability mechanism — survives server restarts.
 */
async function processPendingDelays() {
  const now = new Date().toISOString();

  // Fetch all pending delays that are due
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
      // Mark as processing FIRST to prevent duplicate execution
      const { data: updated, error: updateErr } = await supabase
        .from('pending_delays')
        .update({ status: 'processing' })
        .eq('id', delay.id)
        .eq('status', 'pending')  // Only update if still pending (prevents race)
        .select();

      if (updateErr || !updated || updated.length === 0) {
        console.log(`[DelayPoller] Skipping delay ${delay.id} — already picked up`);
        continue;
      }

      console.log(`[DelayPoller] 🚀 Firing delay for ${delay.commenter_id} → step ${delay.next_step_index}`);

      // Advance the flow
      await advanceFlow({
        commenterId: delay.commenter_id,
        campaignId: delay.campaign_id,
        accessToken: delay.access_token,
        stepIndex: delay.next_step_index
      });

      // Mark as completed
      await supabase
        .from('pending_delays')
        .update({ status: 'completed' })
        .eq('id', delay.id);

      console.log(`[DelayPoller] ✅ Delay ${delay.id} completed for ${delay.commenter_id}`);

    } catch (err) {
      console.error(`[DelayPoller] ❌ Failed to process delay ${delay.id}:`, err.message);

      // Mark as failed so we don't retry infinitely
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
