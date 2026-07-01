const fs = require('fs');
let file = fs.readFileSync('src/routes/analytics.js', 'utf8');
file = file.replace(
  "order('created_at', { ascending: false })",
  "order('sent_at', { ascending: false })"
);
fs.writeFileSync('src/routes/analytics.js', file);
