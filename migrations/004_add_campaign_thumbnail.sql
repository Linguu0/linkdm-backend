-- Add thumbnail_url column for campaign target post
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS target_thumbnail TEXT DEFAULT NULL;
