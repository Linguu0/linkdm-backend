const supabase = require('../db/supabase');
const { enqueueDM } = require('./dmQueue');
const { replyToComment } = require('./instagram');

/**
 * flowRunner.js — Active Flow Execution Service
 * 
 * Handles advancing users through multi-step automation flows.
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
      type: 'text_message',
      campaignId: campaign.id,
      accessToken,
      commentId: currentIndex === 0 ? commentId : null,
      // Auto-reply is handled in webhook.js now (BUG 3 FIX), don't duplicate
      autoReply: false
    });

    // C. Move to next step automatically
    return advanceFlow({ commenterId, campaignId, accessToken, stepIndex: nextIndex, commentId });

  } else if (currentStep.type === 'delay') {
    const delayMs = calculateDelay(currentStep);
    const nextIndex = currentIndex + 1;

    console.log(`[FlowRunner] Delay step: ${delayMs}ms delay, next step will be ${nextIndex}`);

    // Update state to the step AFTER the delay
    await supabase.from('user_flow_states').upsert({
      commenter_id: commenterId,
      campaign_id: campaignId,
      current_step_index: nextIndex,
      last_updated_at: new Date().toISOString()
    }, { onConflict: 'commenter_id, campaign_id' });

    // BUG 2 FIX: Try queue first, fall back to inline setTimeout
    try {
      await enqueueDM({
        commenterId,
        dmMessage: '',
        type: 'flow_advance',
        campaignId: campaignId,
        accessToken,
        delay: delayMs
      });
      console.log(`[FlowRunner] Delay job enqueued for ${delayMs}ms`);
    } catch (queueErr) {
      console.warn(`[FlowRunner] Queue unavailable, using inline delay: ${queueErr.message}`);
      // Inline fallback — use setTimeout to advance after delay
      setTimeout(async () => {
        try {
          console.log(`[FlowRunner] Inline delay fired for ${commenterId}, advancing to step ${nextIndex}`);
          await advanceFlow({ commenterId, campaignId, accessToken, stepIndex: nextIndex });
        } catch (err) {
          console.error(`[FlowRunner] Inline delay advance failed:`, err.message);
        }
      }, delayMs);
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

module.exports = { advanceFlow };
