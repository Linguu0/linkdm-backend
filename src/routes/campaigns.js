const express = require('express');
const axios = require('axios');
const router = express.Router();
const supabase = require('../db/supabase');

// ---------------------------------------------------------------------------
// GET /campaigns — List all campaigns for a given ig_user_id
// ---------------------------------------------------------------------------
router.get('/', async (req, res) => {
  try {
    const igUserId = req.query.ig_user_id || process.env.IG_USER_ID;

    if (!igUserId) {
      return res.status(400).json({ error: 'Missing ig_user_id query param' });
    }

    const { data, error } = await supabase
      .from('campaigns')
      .select('*')
      .eq('ig_user_id', igUserId)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('❌ Error listing campaigns:', error.message);
      return res.status(500).json({ error: error.message });
    }

    console.log(`📋 Retrieved ${data.length} campaigns for ${igUserId}`);
    return res.json({ campaigns: data });
  } catch (err) {
    console.error('❌ GET /campaigns error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// POST /campaigns — Create a new campaign
// ---------------------------------------------------------------------------
router.post('/', async (req, res) => {
  try {
    const {
      name,
      keyword,
      trigger_keyword,
      dm_message,
      ig_user_id,
      dm_type,
      button_template_data,
      quick_replies_data,
      exclude_keywords,
      send_once_per_user,
      exclude_mentions,
      auto_comment_reply,
      flow_data,
    } = req.body;

    const userId = ig_user_id || process.env.IG_USER_ID || '17841462923731141';

    // Accept keyword as array or string, also accept legacy trigger_keyword
    let keywordValue = keyword || trigger_keyword;
    if (!name || !keywordValue || !dm_message) {
      return res.status(400).json({
        error: 'Missing required fields: name, keyword, dm_message',
      });
    }

    // Store trigger_keyword as first keyword (string)
    const triggerKw = Array.isArray(keywordValue) ? keywordValue[0] : keywordValue.split(',')[0]?.trim();

    // Normalize keyword to array for JSONB storage
    if (typeof keywordValue === 'string') {
      keywordValue = keywordValue.split(',').map((k) => k.toLowerCase().trim()).filter(Boolean);
    } else if (Array.isArray(keywordValue)) {
      keywordValue = keywordValue.map((k) => k.toLowerCase().trim()).filter(Boolean);
    }

    // Get access token — required by DB schema
    let accessToken = process.env.ACCESS_TOKEN || '';
    if (!accessToken) {
      // Try to get from users table
      const { data: userData } = await supabase
        .from('users')
        .select('access_token')
        .eq('ig_user_id', userId)
        .single();
      accessToken = userData?.access_token || 'pending';
    }

    // Build payload matching actual DB columns:
    // id (auto), access_token, ig_user_id, name, keyword,
    // dm_message, is_active, created_at, dm_type, button_template_data,
    // quick_replies_data, exclude_keywords, send_once_per_user, exclude_mentions
    const payload = {
      access_token: accessToken,
      ig_user_id: userId,
      name,
      keyword: keywordValue,
      dm_message,
      is_active: true,
      created_at: new Date().toISOString(),
      dm_type: dm_type || 'text_message',
      button_template_data: button_template_data || null,
      quick_replies_data: quick_replies_data || null,
      exclude_keywords: exclude_keywords || null,
      send_once_per_user: send_once_per_user !== undefined ? send_once_per_user : true,
      exclude_mentions: exclude_mentions !== undefined ? exclude_mentions : false,
      auto_comment_reply: auto_comment_reply !== undefined ? auto_comment_reply : true,
      target_type: req.body.target_type || 'all_posts',
      target_media_id: req.body.target_media_id || null,
      target_thumbnail: req.body.target_thumbnail || null,
      flow_data: flow_data || null,
    };

    // If target_media_id is a shortcode, try to resolve it (best effort)
    if (payload.target_media_id && !/^\d+$/.test(payload.target_media_id)) {
      console.log(`🔍 Attempting to resolve shortcode ${payload.target_media_id} to numeric ID...`);
      // We'll keep the shortcode for now, but in a real production app, 
      // we'd use the Graph API to resolve it. 
      // For this implementation, we'll rely on the 'Ready to Setup' grid 
      // which already provides numeric IDs.
    }

    const { data, error } = await supabase
      .from('campaigns')
      .insert(payload)
      .select();

    if (error) {
      console.error('❌ Error creating campaign:', error.message);
      return res.status(500).json({ error: error.message });
    }

    console.log(`✅ Campaign "${name}" created with keywords: ${JSON.stringify(keywordValue)}`);
    return res.status(201).json({ campaign: data[0] });
  } catch (err) {
    console.error('❌ POST /campaigns error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// PATCH /campaigns/:id — Update campaign (toggle is_active, edit fields)
// ---------------------------------------------------------------------------
router.patch('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body; // { is_active, name, keyword, dm_message }

    if (!id) {
      return res.status(400).json({ error: 'Missing campaign id' });
    }

    // Normalize keyword if it's being updated
    if (updates.keyword) {
      if (typeof updates.keyword === 'string') {
        updates.keyword = updates.keyword.split(',').map((k) => k.toLowerCase().trim()).filter(Boolean);
      } else if (Array.isArray(updates.keyword)) {
        updates.keyword = updates.keyword.map((k) => k.toLowerCase().trim()).filter(Boolean);
      }
    }

    updates.updated_at = new Date().toISOString();

    const { data, error } = await supabase
      .from('campaigns')
      .update(updates)
      .eq('id', id)
      .select();

    if (error) {
      console.error('❌ Error updating campaign:', error.message);
      return res.status(500).json({ error: error.message });
    }

    if (!data || data.length === 0) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    console.log(`✏️  Campaign ${id} updated`);
    return res.json({ campaign: data[0] });
  } catch (err) {
    console.error('❌ PATCH /campaigns/:id error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// DELETE /campaigns/:id — Delete a campaign
// ---------------------------------------------------------------------------
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    if (!id) {
      return res.status(400).json({ error: 'Missing campaign id' });
    }

    const { data, error } = await supabase
      .from('campaigns')
      .delete()
      .eq('id', id)
      .select();

    if (error) {
      console.error('❌ Error deleting campaign:', error.message);
      return res.status(500).json({ error: error.message });
    }

    if (!data || data.length === 0) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    console.log(`🗑️  Campaign ${id} deleted`);
    return res.json({ message: 'Campaign deleted', campaign: data[0] });
  } catch (err) {
    console.error('❌ DELETE /campaigns/:id error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// GET /preview — Fetch post info from Instagram Graph API
// ---------------------------------------------------------------------------
router.get('/preview', async (req, res) => {
  try {
    const { url } = req.query;

    if (!url) {
      return res.status(400).json({ error: 'Missing url query param' });
    }

    // Extract media shortcode or ID from URL
    let mediaId = url.trim();
    const urlMatch = url.match(/instagram\.com\/(?:reel|p)\/([A-Za-z0-9_-]+)/);
    if (urlMatch) {
      mediaId = urlMatch[1];
    }

    // If it's a shortcode, we need to resolve it to a media ID via oEmbed or direct API
    // For now, use the IG oEmbed endpoint to get basic info
    const igUserId = process.env.IG_USER_ID;
    
    // Try to get user's access token from Supabase
    const { data: userData, error: userError } = await supabase
      .from('users')
      .select('access_token')
      .eq('ig_user_id', igUserId)
      .single();

    if (userError || !userData) {
      // If no token, return a parsed preview without API call
      console.log('⚠️  No access token found, returning parsed preview');
      return res.json({
        id: mediaId,
        type: url.includes('/reel/') ? 'VIDEO' : 'IMAGE',
        thumbnail_url: null,
        timestamp: null,
      });
    }

    const accessToken = userData.access_token;

    // If we have a numeric media ID, query directly
    if (/^\d+$/.test(mediaId)) {
      const igRes = await axios.get(
        `https://graph.instagram.com/${mediaId}?fields=id,media_type,thumbnail_url,timestamp&access_token=${accessToken}`
      );

      const igData = igRes.data;
      console.log(`✅ Post preview fetched: ${igData.id} (${igData.media_type})`);

      return res.json({
        id: igData.id,
        type: igData.media_type || 'IMAGE',
        thumbnail_url: igData.thumbnail_url || null,
        timestamp: igData.timestamp || null,
      });
    }

    // For shortcodes, try to find the media via user's recent media
    console.log(`ℹ️  Shortcode detected: ${mediaId}, attempting resolution via recent media...`);
    
    try {
      const recentRes = await axios.get(
        `https://graph.instagram.com/v21.0/me/media?fields=id,permalink,thumbnail_url,media_type,timestamp&access_token=${accessToken}`
      );
      
      const match = recentRes.data.data?.find(m => m.permalink.includes(mediaId));
      if (match) {
        console.log(`✅ Shortcode ${mediaId} resolved to ${match.id}`);
        return res.json({
          id: match.id,
          type: match.media_type || 'IMAGE',
          thumbnail_url: match.thumbnail_url || null,
          timestamp: match.timestamp || null,
        });
      }
    } catch (e) {
      console.warn('Resolution failed', e.message);
    }

    return res.json({
      id: mediaId,
      type: url.includes('/reel/') ? 'VIDEO' : 'IMAGE',
      thumbnail_url: null,
      timestamp: null,
    });
  } catch (err) {
    console.error('❌ GET /posts/preview error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch post preview' });
  }
});

// ---------------------------------------------------------------------------
// GET /media — Fetch recent media posts from Instagram
// ---------------------------------------------------------------------------
router.get('/media', async (req, res) => {
  console.log('📌 GET /posts/media endpoint hit');
  try {
    const accessToken = process.env.ACCESS_TOKEN;

    if (!accessToken) {
      console.log('⚠️  No access token found in environment variables (process.env.ACCESS_TOKEN missing)');
      return res.status(401).json({ error: 'Instagram access token missing in backend configuration' });
    }

    // Call Instagram Graph API
    const igUrl = `https://graph.instagram.com/v21.0/me/media?fields=id,caption,media_type,thumbnail_url,media_url,timestamp,permalink&limit=50&access_token=${accessToken}`;
    
    console.log(`🌍 Calling Instagram API: ${igUrl.replace(accessToken, '[HIDDEN_TOKEN]')}`);
    
    const igRes = await axios.get(igUrl, { timeout: 15000 });
    const data = igRes.data;
    console.log(`✅ Instagram API success. Received ${data.data?.length || 0} posts.`);
    
    // Map Instagram data to our format
    const posts = (data.data || []).map((post) => ({
      id: post.id,
      caption: post.caption || '',
      media_type: post.media_type,
      thumbnail_url: post.media_type === 'VIDEO' ? post.thumbnail_url : post.media_url,
      media_url: post.media_url,
      timestamp: post.timestamp,
      permalink: post.permalink,
    }));

    return res.json({ posts });
  } catch (err) {
    console.error('❌ GET /posts/media error details:', err);
    return res.status(500).json({ error: 'Internal server error', details: err.message });
  }
});

module.exports = router;
