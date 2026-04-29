require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

async function run() {
  const { data: camps } = await supabase.from('campaigns').select('*').eq('is_active', true);
  console.log('ACTIVE CAMPAIGNS:');
  console.log(JSON.stringify(camps, null, 2));

  const { data: logs } = await supabase.from('dm_logs').select('*').eq('commenter_id', '908055198821808').order('sent_at', { ascending: false }).limit(5);
  console.log('\nRECENT LOGS FOR 908055198821808:');
  console.log(JSON.stringify(logs, null, 2));
}

run();
