const Queue = require('bull');
const IORedis = require('ioredis');
const { sendDirectMessage, replyToComment } = require('./instagram');
const supabase = require('../db/supabase');

// ---------------------------------------------------------------------------
// Redis connection — Upstash requires TLS; Bull accepts an ioredis instance
// ---------------------------------------------------------------------------
const redisUrl = process.env.REDIS_URL;

function createRedisClient() {
  return new IORedis(redisUrl, {
    tls: { rejectUnauthorized: false },
    maxRetriesPerRequest: null,       // required by Bull
    enableReadyCheck: false,
  });
}

// ---------------------------------------------------------------------------
// Bull queue
// ---------------------------------------------------------------------------
const dmQueue = new Queue('dm-queue', {
  createClient: (type) => createRedisClient(),
  limiter: {
    max: 10,        // max 10 jobs
    duration: 60000, // per minute
  },
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 5000,  // first retry after 5 s, then 10 s, then 20 s
    },
    removeOnComplete: true,
    removeOnFail: false,
  },
});

console.log('✅ Bull DM queue initialized');

// Health check events
dmQueue.on('ready', () => console.log('✅ Bull queue READY — actively consuming jobs'));
dmQueue.on('error', (err) => console.error('❌ Bull queue connection ERROR:', err.message));
dmQueue.on('stalled', (job) => console.warn('⚠️ Job stalled:', job.id));

// ---------------------------------------------------------------------------
// Processor — runs for each job
// ---------------------------------------------------------------------------
dmQueue.process(async (job) => {
  const { commenterId, dmMessage, type, campaignId, accessToken, autoReply, commentId } = job.data;

  console.log(`⚙️  Processing ${type || 'link'} DM job ${job.id} → commenter ${commenterId}`);

  let dmSuccess = true;
  let dmErrorMsg = null;

  // 1. Send the DM via Instagram Graph API
  try {
    await sendDirectMessage(accessToken, commenterId, dmMessage, type, commentId);
  } catch (err) {
    dmSuccess = false;
    dmErrorMsg = err.response?.data?.error?.message || err.message;
    console.warn(`⚠️ Failed to send DM to ${commenterId}:`, dmErrorMsg);
    console.warn("If you are testing from your own account, Instagram does not allow sending DMs to yourself.");
  }

  // 1.5 Auto Reply to comment if enabled
  if (autoReply && commentId) {
    try {
      // Small delay just to act natural if we also sent a DM
      await new Promise(res => setTimeout(res, 1000));
      await replyToComment(accessToken, commentId, 'Check your DMs! 📩');
    } catch (err) {
      console.warn(`⚠️ Failed to reply to comment ${commentId}:`, err.response?.data?.error?.message || err.message);
    }
  }

  // 2. Log to dm_logs table (even if DM failed, we want to know it attempted and the status)
  const logMessage = dmSuccess ? dmMessage : `FAILED: ${dmErrorMsg}`;
  const { error } = await supabase.from('dm_logs').insert({
    campaign_id: campaignId,
    commenter_id: commenterId,
    dm_message: logMessage,
    type: type || 'link',
    sent_at: new Date().toISOString(),
  });

  if (error) {
    console.error('❌ Failed to insert dm_log:', error.message);
    // Don't throw to retry, as we already attempted the DM. Just finish job.
  }

  if (dmSuccess) {
    console.log(`✅ DM logged successfully for commenter ${commenterId}`);
  } else {
    // If we want Bull to record it as failed, we can throw here after logging to DB
    // but typically we don't want to retry 400 Bad Requests indefinitely.
    console.log(`❌ DM failed for commenter ${commenterId}, but logged attempt.`);
  }
});

// ---------------------------------------------------------------------------
// Event listeners
// ---------------------------------------------------------------------------
dmQueue.on('failed', (job, err) => {
  console.error(`❌ Job ${job.id} failed after ${job.attemptsMade} attempts:`, err.message);
});

dmQueue.on('completed', (job) => {
  console.log(`🎉 Job ${job.id} completed`);
});

// ---------------------------------------------------------------------------
// Helper — add a DM job to the queue
// ---------------------------------------------------------------------------
async function enqueueDM({ commenterId, dmMessage, type, campaignId, accessToken, autoReply, commentId }) {
  const job = await dmQueue.add({
    commenterId,
    dmMessage,
    type,
    campaignId,
    accessToken,
    autoReply,
    commentId,
  });

  console.log(`📥 Enqueued ${type || 'link'} DM job ${job.id} for commenter ${commenterId}`);
  return job;
}

module.exports = { dmQueue, enqueueDM };
