const supabase = require('./src/db/supabase');
async function test() {
  const { data, error } = await supabase.from('users').select('*');
  console.log("Users:", data);
  console.log("Error:", error);
}
test();
