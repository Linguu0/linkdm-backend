require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

async function checkLogs() {
  console.log('Checking recent dm_logs...');
  const { data, error } = await supabase
    .from('dm_logs')
    .select('*')
    .order('sent_at', { ascending: false })
    .limit(10);

  if (error) {
    console.error('Error fetching logs:', error.message);
    return;
  }

  if (data.length === 0) {
    console.log('No logs found in dm_logs table.');
  } else {
    console.table(data.map(log => ({
      id: log.id,
      campaign_id: log.campaign_id,
      commenter_id: log.commenter_id,
      type: log.type,
      sent_at: log.sent_at,
      message_preview: log.dm_message?.substring(0, 50)
    })));
  }
}

checkLogs();
