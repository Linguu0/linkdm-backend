const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

async function fix() {
  const { data, error } = await supabase
    .from('campaigns')
    .update({ ig_user_id: '17841462923731141' })
    .eq('id', '8f75719e-c9c0-487d-b4de-cd26d1d4f2aa');
  
  if (error) {
    console.error('Error:', error.message);
  } else {
    console.log('Fixed! Updated ig_user_id to 17841462923731141');
  }
}
fix();
