require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');

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
  const commentId = log.comment_id;
  
  const url = `https://graph.instagram.com/v21.0/${commentId}/replies`;
  const payload = { message: 'Testing auto reply!' };
  
  console.log("Testing graph.instagram.com with Bearer token...");
  try {
    const response = await axios.post(url, payload, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });
    console.log("Success!", response.data);
  } catch (err) {
    console.error("Error:", err.response?.data?.error?.message || err.message);
  }
}

test();
