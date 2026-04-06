require('dotenv').config();
const { dmQueue } = require('./src/services/dmQueue.js');

async function check() {
  const failedJobs = await dmQueue.getFailed();
  for (const job of failedJobs) {
    console.log(`Job ${job.id} failed with reason:`, job.failedReason);
    console.log(job.stacktrace);
  }
  process.exit();
}
setTimeout(check, 1000);
