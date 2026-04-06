require('dotenv').config();
const supabase = require('./src/db/supabase.js');

async function check() {
  const { data: users, error: err1 } = await supabase.from('users').select('*').limit(5);
  console.log("Users:", err1 ? err1 : users);
}
check();
