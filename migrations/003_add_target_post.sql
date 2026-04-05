-- ═══════════════════════════════════════
-- Migration: Add target_type and target_media_id
-- to campaigns table
-- ═══════════════════════════════════════

-- Add target_type column (all_posts or specific_post)
ALTER TABLE campaigns 
ADD COLUMN IF NOT EXISTS target_type TEXT DEFAULT 'all_posts';

-- Add target_media_id column (null for all_posts, media ID for specific_post)
ALTER TABLE campaigns 
ADD COLUMN IF NOT EXISTS target_media_id TEXT DEFAULT NULL;

-- Add index for faster webhook lookups on specific posts
CREATE INDEX IF NOT EXISTS idx_campaigns_target_media_id 
ON campaigns (target_media_id) 
WHERE target_media_id IS NOT NULL;
