-- ═══════════════════════════════════════
-- Migration: Add advanced LinkDM campaign fields
-- ═══════════════════════════════════════

ALTER TABLE campaigns 
ADD COLUMN IF NOT EXISTS dm_type TEXT DEFAULT 'text_message';

ALTER TABLE campaigns 
ADD COLUMN IF NOT EXISTS button_template_data JSONB DEFAULT NULL;

ALTER TABLE campaigns 
ADD COLUMN IF NOT EXISTS quick_replies_data JSONB DEFAULT NULL;

ALTER TABLE campaigns 
ADD COLUMN IF NOT EXISTS exclude_keywords JSONB DEFAULT NULL;

ALTER TABLE campaigns 
ADD COLUMN IF NOT EXISTS send_once_per_user BOOLEAN DEFAULT true;

ALTER TABLE campaigns 
ADD COLUMN IF NOT EXISTS exclude_mentions BOOLEAN DEFAULT false;
