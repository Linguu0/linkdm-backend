const supabase = require('./supabase');

/**
 * Run all pending column migrations on startup.
 * Uses ADD COLUMN IF NOT EXISTS logic via raw SQL (Supabase RPC).
 * Falls back gracefully if RPC is unavailable — columns will just
 * error naturally and the route-level fallback will handle it.
 */
async function runMigrations() {
  console.log('🔄 Running database migrations...');

  const columns = [
    // Migration 002
    { name: 'trigger_type', sql: `ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS trigger_type TEXT DEFAULT 'reel_comment';` },
    { name: 'auto_comment_reply', sql: `ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS auto_comment_reply BOOLEAN DEFAULT true;` },
    // Migration 003
    { name: 'target_type', sql: `ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS target_type TEXT DEFAULT 'all_posts';` },
    { name: 'target_media_id', sql: `ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS target_media_id TEXT DEFAULT NULL;` },
    // Migration 004
    { name: 'dm_type', sql: `ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS dm_type TEXT DEFAULT 'text_message';` },
    { name: 'button_template_data', sql: `ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS button_template_data JSONB DEFAULT NULL;` },
    { name: 'quick_replies_data', sql: `ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS quick_replies_data JSONB DEFAULT NULL;` },
    { name: 'exclude_keywords', sql: `ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS exclude_keywords JSONB DEFAULT NULL;` },
    { name: 'send_once_per_user', sql: `ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS send_once_per_user BOOLEAN DEFAULT true;` },
    { name: 'exclude_mentions', sql: `ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS exclude_mentions BOOLEAN DEFAULT false;` },
    // Migration 005
    { name: 'flow_data', sql: `ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS flow_data JSONB DEFAULT NULL;` },
  ];

  for (const col of columns) {
    try {
      const { error } = await supabase.rpc('exec_sql', { query: col.sql });
      if (error) {
        // RPC might not exist — that's okay, we'll try direct approach
        if (error.message.includes('function') && error.message.includes('does not exist')) {
          console.log(`⚠️  RPC exec_sql not available. Skipping auto-migration for "${col.name}".`);
          break; // No point trying the rest
        }
        console.warn(`⚠️  Migration for "${col.name}": ${error.message}`);
      } else {
        console.log(`  ✅ Column "${col.name}" ensured`);
      }
    } catch (err) {
      console.warn(`⚠️  Migration error for "${col.name}": ${err.message}`);
    }
  }

  console.log('✅ Migration check complete');
}

module.exports = { runMigrations };
