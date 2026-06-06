-- ═══════════════════════════════════════
-- Migration: Add followers_only filter to campaigns
-- ═══════════════════════════════════════

ALTER TABLE campaigns 
ADD COLUMN IF NOT EXISTS followers_only BOOLEAN DEFAULT false;
