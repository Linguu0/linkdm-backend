-- ═══════════════════════════════════════
-- Migration: Add trigger_type, auto_comment_reply, 
-- and convert keyword to JSONB
-- ═══════════════════════════════════════

-- Add trigger_type column
ALTER TABLE campaigns 
ADD COLUMN IF NOT EXISTS trigger_type TEXT DEFAULT 'reel_comment';

-- Add auto_comment_reply column
ALTER TABLE campaigns 
ADD COLUMN IF NOT EXISTS auto_comment_reply BOOLEAN DEFAULT true;

-- Convert keyword column from TEXT to JSONB
-- First, update existing text values to JSON arrays
UPDATE campaigns 
SET keyword = to_jsonb(ARRAY[keyword::text])
WHERE keyword IS NOT NULL 
  AND jsonb_typeof(keyword::jsonb) IS DISTINCT FROM 'array';

-- Note: If the above UPDATE fails because keyword is plain text,
-- run this instead:
-- ALTER TABLE campaigns ALTER COLUMN keyword TYPE JSONB USING to_jsonb(ARRAY[keyword]);
