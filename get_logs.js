const fs = require('fs');
let file = fs.readFileSync('src/routes/analytics.js', 'utf8');
file = file.replace(
  "module.exports = router;",
  "router.get('/debug-logs', async (req, res) => { const { data } = await supabase.from('dm_logs').select('*').order('created_at', { ascending: false }).limit(10); res.json(data); });\nmodule.exports = router;"
);
fs.writeFileSync('src/routes/analytics.js', file);
