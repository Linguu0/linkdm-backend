require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

async function checkRecentEvents() {
  console.log('Checking recent dm_logs (including debug)...');
  const { data, error } = await supabase
    .from('dm_logs')
    .select('*')
    .order('sent_at', { ascending: false })
    .limit(10);

  if (error) {
    console.error('Error fetching logs:', error.message);
    return;
  }

  console.table(data.map(log => ({
    id: log.id,
    campaign_id: log.campaign_id,
    commenter_id: log.commenter_id,
    status: log.status,
    sent_at: log.sent_at,
    message: log.dm_message
  })));
}

checkRecentEvents();
