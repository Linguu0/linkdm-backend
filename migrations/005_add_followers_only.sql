-- ═══════════════════════════════════════
-- Migration: Make followers_only always TRUE
-- ═══════════════════════════════════════

-- Update all existing campaigns
UPDATE campaigns SET followers_only = true;

-- Change default for future campaigns
ALTER TABLE campaigns ALTER COLUMN followers_only SET DEFAULT true;
