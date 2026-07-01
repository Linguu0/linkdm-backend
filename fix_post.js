const fs = require('fs');
let file = fs.readFileSync('src/routes/campaigns.js', 'utf8');
file = file.replace(
  "let accessToken = process.env.ACCESS_TOKEN || '';\n    if (!accessToken) {",
  "let accessToken = '';\n    const { data: userData } = await supabase.from('users').select('access_token').eq('ig_user_id', userId).single();\n    accessToken = userData?.access_token || process.env.ACCESS_TOKEN;\n    if (!accessToken) {"
);
fs.writeFileSync('src/routes/campaigns.js', file);
