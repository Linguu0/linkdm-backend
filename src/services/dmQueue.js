const Queue = require('bull');
const IORedis = require('ioredis');
const { sendDirectMessage } = require('./instagram');
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

// ---------------------------------------------------------------------------
// Processor — runs for each job
// ---------------------------------------------------------------------------
dmQueue.process(async (job) => {
  const { commenterId, dmMessage, type, campaignId, accessToken } = job.data;

  console.log(`⚙️  Processing ${type || 'link'} DM job ${job.id} → commenter ${commenterId}`);

  // 1. Send the DM via Instagram Graph API
  await sendDirectMessage(accessToken, commenterId, dmMessage, type);

  // 2. Log to dm_logs table
  const { error } = await supabase.from('dm_logs').insert({
    campaign_id: campaignId,
    commenter_id: commenterId,
    dm_message: dmMessage,
    type: type || 'link',
    sent_at: new Date().toISOString(),
  });

  if (error) {
    console.error('❌ Failed to insert dm_log:', error.message);
    throw error; // triggers retry
  }

  console.log(`✅ DM logged for commenter ${commenterId}, campaign ${campaignId}`);
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
async function enqueueDM({ commenterId, dmMessage, type, campaignId, accessToken }) {
  const job = await dmQueue.add({
    commenterId,
    dmMessage,
    type,
    campaignId,
    accessToken,
  });

  console.log(`📥 Enqueued ${type || 'link'} DM job ${job.id} for commenter ${commenterId}`);
  return job;
}

module.exports = { dmQueue, enqueueDM };
