const fs = require('fs');
let file = fs.readFileSync('src/routes/webhook.js', 'utf8');
file = file.replace(
  "let accessToken = null;\n        if (campaigns.length > 0 && campaigns[0].access_token) {\n          accessToken = campaigns[0].access_token;\n        }\n        if (!accessToken) {\n          accessToken = process.env.ACCESS_TOKEN;\n        }",
  "let accessToken = null;\n        const { data: pageUser } = await supabase.from('users').select('access_token').eq('ig_user_id', webhookUserId).single();\n        accessToken = pageUser?.access_token;\n        if (!accessToken && campaigns.length > 0) {\n          accessToken = campaigns[0].access_token;\n        }\n        if (!accessToken) {\n          accessToken = process.env.ACCESS_TOKEN;\n        }"
);
fs.writeFileSync('src/routes/webhook.js', file);
