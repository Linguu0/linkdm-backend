const fs = require('fs');
let file = fs.readFileSync('src/routes/campaigns.js', 'utf8');
file = file.replace(
  "const updates = req.body; // { is_active, name, keyword, dm_message }",
  "const updates = { ...req.body };\n    delete updates.trigger_keyword;\n    delete updates.ig_user_id;"
);
fs.writeFileSync('src/routes/campaigns.js', file);
