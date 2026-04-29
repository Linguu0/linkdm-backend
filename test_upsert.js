require('dotenv').config();
const supabase = require('./src/db/supabase');
async function run() {
  const { data, error } = await supabase
    .from('user_flow_states')
    .upsert({
      commenter_id: 'test_user',
      campaign_id: '95ee3bd9-3b20-4cdd-9ca8-40c2f20c0e54',
      current_step_index: 1,
      last_updated_at: new Date().toISOString()
    }, { onConflict: 'commenter_id, campaign_id' });
  console.log('Error:', error);
}
run();
