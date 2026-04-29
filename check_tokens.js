require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

async function checkToken(token, name) {
  try {
    const res = await axios.get(`https://graph.instagram.com/v21.0/me?fields=id,username&access_token=${token}`);
    console.log(`✅ Token for "${name}" is VALID: ${res.data.username} (${res.data.id})`);
    return true;
  } catch (e) {
    console.error(`❌ Token for "${name}" is INVALID:`, e.response?.data?.error?.message || e.message);
    return false;
  }
}

async function run() {
  const { data: camps } = await supabase.from('campaigns').select('name, access_token').eq('is_active', true);
  
  console.log('Checking active campaign tokens...');
  for (const camp of camps) {
    await checkToken(camp.access_token, camp.name);
  }

  console.log('\nChecking ENV token...');
  await checkToken(process.env.ACCESS_TOKEN, 'ENV ACCESS_TOKEN');
}

run();
