const axios = require('axios');

const GRAPH_URL = 'https://graph.instagram.com/v18.0';
const API_URL = 'https://api.instagram.com';

/**
 * Send a DM to an Instagram user via the Messaging API.
 *
 * @param {string} accessToken – Page/user access token
 * @param {string} recipientId – IGSID of the recipient
 * @param {string} messageText – The DM body
 * @returns {object} API response data
 */
async function sendDirectMessage(accessToken, recipientId, messageText) {
  const url = `${GRAPH_URL}/me/messages`;

  const payload = {
    recipient: { id: recipientId },
    message: { text: messageText },
  };

  console.log(`📩 Sending DM to ${recipientId}...`);

  const response = await axios.post(url, payload, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
  });

  console.log(`✅ DM sent successfully to ${recipientId}`);
  return response.data;
}

/**
 * Exchange an authorization code for a short-lived access token.
 *
 * Instagram requires a POST with form-urlencoded body to:
 *   https://api.instagram.com/oauth/access_token
 */
async function exchangeCodeForToken(code) {
  const url = `${API_URL}/oauth/access_token`;

  const params = new URLSearchParams();
  params.append('client_id', process.env.IG_APP_ID);
  params.append('client_secret', process.env.IG_APP_SECRET);
  params.append('grant_type', 'authorization_code');
  params.append('redirect_uri', process.env.REDIRECT_URI);
  params.append('code', code);

  const response = await axios.post(url, params, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });

  console.log('🔑 Short-lived token obtained');
  return response.data; // { access_token, user_id }
}

/**
 * Exchange a short-lived token for a long-lived token (60 days).
 *
 * GET https://graph.instagram.com/access_token
 *   ?grant_type=ig_exchange_token
 *   &client_secret=...
 *   &access_token=...
 */
async function exchangeForLongLivedToken(shortLivedToken) {
  const url = `${GRAPH_URL}/access_token`;

  const response = await axios.get(url, {
    params: {
      grant_type: 'ig_exchange_token',
      client_secret: process.env.IG_APP_SECRET,
      access_token: shortLivedToken,
    },
  });

  console.log('🔑 Long-lived token obtained (60 days)');
  return response.data; // { access_token, token_type, expires_in }
}

module.exports = {
  sendDirectMessage,
  exchangeCodeForToken,
  exchangeForLongLivedToken,
};
