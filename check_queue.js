const Queue = require('bull');
const IORedis = require('ioredis');
require('dotenv').config();

const redisUrl = process.env.REDIS_URL;

function createRedisClient() {
  return new IORedis(redisUrl, {
    tls: { rejectUnauthorized: false },
    maxRetriesPerRequest: null,
    connectTimeout: 10000,
  });
}

async function checkQueue() {
  const dmQueue = new Queue('dm-queue', {
    createClient: (type) => createRedisClient(),
  });

  try {
    const [waiting, active, completed, failed, delayed] = await Promise.all([
      dmQueue.getWaitingCount(),
      dmQueue.getActiveCount(),
      dmQueue.getCompletedCount(),
      dmQueue.getFailedCount(),
      dmQueue.getDelayedCount(),
    ]);

    console.log('Queue Status:');
    console.log('Waiting:', waiting);
    console.log('Active:', active);
    console.log('Completed:', completed);
    console.log('Failed:', failed);
    console.log('Delayed:', delayed);

    const failedJobs = await dmQueue.getFailed(0, 5);
    if (failedJobs.length > 0) {
      console.log('\nRecent Failed Jobs:');
      failedJobs.forEach(job => {
        console.log(`Job ${job.id}: ${job.failedReason}`);
      });
    }

    process.exit(0);
  } catch (err) {
    console.error('Error checking queue:', err.message);
    process.exit(1);
  }
}

checkQueue();
