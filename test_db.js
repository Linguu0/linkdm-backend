require('dotenv').config();
const supabase = require('./src/db/supabase.js');

async function check() {
  const { data: camps, error: err1 } = await supabase.from('campaigns').select('name, is_active, keyword, ig_user_id');
  console.log("Campaigns:", err1 ? err1 : camps);
}
check();
