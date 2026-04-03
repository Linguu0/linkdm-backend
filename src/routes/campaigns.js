const express = require('express');
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
    const { name, keyword, dm_message, ig_user_id } = req.body;

    const userId = ig_user_id || process.env.IG_USER_ID;

    if (!name || !keyword || !dm_message) {
      return res.status(400).json({
        error: 'Missing required fields: name, keyword, dm_message',
      });
    }

    const { data, error } = await supabase
      .from('campaigns')
      .insert({
        ig_user_id: userId,
        name,
        keyword: keyword.toLowerCase().trim(),
        dm_message,
        is_active: true,
        created_at: new Date().toISOString(),
      })
      .select();

    if (error) {
      console.error('❌ Error creating campaign:', error.message);
      return res.status(500).json({ error: error.message });
    }

    console.log(`✅ Campaign "${name}" created with keyword "${keyword}"`);
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
      updates.keyword = updates.keyword.toLowerCase().trim();
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

module.exports = router;
