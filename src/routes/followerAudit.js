const express = require('express');
const axios = require('axios');
const supabase = require('../db/supabase');

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const { data: userData } = await supabase
      .from('users')
      .select('access_token, ig_user_id')
      .limit(1)
      .single();
    
    const token = userData?.access_token || process.env.ACCESS_TOKEN;
    if (!token) return res.status(400).json({ error: 'No token' });

    const results = {};

    // 1. Online followers (hourly breakdown - shows how many are ACTIVE)
    try {
      const resp = await axios.get('https://graph.instagram.com/v21.0/me/insights', {
        params: {
          metric: 'online_followers',
          period: 'lifetime',
          access_token: token,
        },
        timeout: 15000,
      });
      results.online_followers = resp.data?.data?.[0]?.values || [];
    } catch (err) {
      results.online_followers = { error: err.response?.data?.error?.message || err.message };
    }

    // 2. Follower demographics (country, city, age-gender)
    try {
      const resp = await axios.get('https://graph.instagram.com/v21.0/me/insights', {
        params: {
          metric: 'follower_demographics',
          period: 'lifetime',
          metric_type: 'total_value',
          breakdown: 'country',
          access_token: token,
        },
        timeout: 15000,
      });
      results.follower_countries = resp.data?.data?.[0]?.total_value?.breakdowns?.[0]?.results || [];
    } catch (err) {
      results.follower_countries = { error: err.response?.data?.error?.message || err.message };
    }

    // 3. Follower demographics by city
    try {
      const resp = await axios.get('https://graph.instagram.com/v21.0/me/insights', {
        params: {
          metric: 'follower_demographics',
          period: 'lifetime',
          metric_type: 'total_value',
          breakdown: 'city',
          access_token: token,
        },
        timeout: 15000,
      });
      results.follower_cities = resp.data?.data?.[0]?.total_value?.breakdowns?.[0]?.results || [];
    } catch (err) {
      results.follower_cities = { error: err.response?.data?.error?.message || err.message };
    }

    // 4. Follower demographics by age-gender
    try {
      const resp = await axios.get('https://graph.instagram.com/v21.0/me/insights', {
        params: {
          metric: 'follower_demographics',
          period: 'lifetime',
          metric_type: 'total_value',
          breakdown: 'age,gender',
          access_token: token,
        },
        timeout: 15000,
      });
      results.follower_age_gender = resp.data?.data?.[0]?.total_value?.breakdowns?.[0]?.results || [];
    } catch (err) {
      results.follower_age_gender = { error: err.response?.data?.error?.message || err.message };
    }

    // 5. Follows and unfollows (last 30 days)
    try {
      const resp = await axios.get('https://graph.instagram.com/v21.0/me/insights', {
        params: {
          metric: 'follows_and_unfollows',
          period: 'day',
          metric_type: 'time_series',
          since: Math.floor((Date.now() - 30 * 24 * 60 * 60 * 1000) / 1000),
          until: Math.floor(Date.now() / 1000),
          access_token: token,
        },
        timeout: 15000,
      });
      results.follows_unfollows = resp.data?.data || [];
    } catch (err) {
      results.follows_unfollows = { error: err.response?.data?.error?.message || err.message };
    }

    // 6. Reach last 30 days
    try {
      const resp = await axios.get('https://graph.instagram.com/v21.0/me/insights', {
        params: {
          metric: 'reach',
          period: 'day',
          metric_type: 'time_series',
          since: Math.floor((Date.now() - 30 * 24 * 60 * 60 * 1000) / 1000),
          until: Math.floor(Date.now() / 1000),
          access_token: token,
        },
        timeout: 15000,
      });
      results.reach_30d = resp.data?.data?.[0]?.values || [];
    } catch (err) {
      results.reach_30d = { error: err.response?.data?.error?.message || err.message };
    }

    // 7. Unique commenters from our DM logs (real engagement check)
    try {
      const { data: logs } = await supabase
        .from('dm_logs')
        .select('commenter_id, status, sent_at')
        .neq('status', 'debug');

      const uniqueUsers = new Set(logs?.map(l => l.commenter_id) || []);
      const repeatUsers = {};
      for (const log of (logs || [])) {
        repeatUsers[log.commenter_id] = (repeatUsers[log.commenter_id] || 0) + 1;
      }
      const repeaters = Object.values(repeatUsers).filter(v => v > 1).length;

      results.engagement_quality = {
        total_interacted_users: uniqueUsers.size,
        repeat_users: repeaters,
        one_time_users: uniqueUsers.size - repeaters,
        pct_one_time: uniqueUsers.size > 0 ? ((uniqueUsers.size - repeaters) / uniqueUsers.size * 100).toFixed(1) + '%' : '0%'
      };
    } catch (err) {
      results.engagement_quality = { error: err.message };
    }

    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
