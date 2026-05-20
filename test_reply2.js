require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { replyToComment } = require('./src/services/instagram');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

async function test() {
  const { data: logs } = await supabase
    .from('dm_logs')
    .select('*')
    .not('comment_id', 'is', null)
    .neq('status', 'debug')
    .order('sent_at', { ascending: false })
    .limit(1);
    
  const log = logs[0];
  const { data: campaigns } = await supabase
    .from('campaigns')
    .select('access_token')
    .eq('id', log.campaign_id)
    .limit(1);
    
  let token = (campaigns && campaigns[0] && campaigns[0].access_token) ? campaigns[0].access_token : process.env.ACCESS_TOKEN;
  console.log("Token starts with:", token ? token.substring(0, 15) : "NULL/UNDEFINED");
}

test();
