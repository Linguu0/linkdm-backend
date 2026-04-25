const axios = require('axios');

const GRAPH_URL = 'https://graph.instagram.com/v21.0';
const FB_GRAPH_URL = 'https://graph.facebook.com/v21.0';
const API_URL = 'https://api.instagram.com';

/**
 * Send a DM to an Instagram user via the Messaging API.
 *
 * @param {string} accessToken – Page/user access token
 * @param {string} recipientId – IGSID of the recipient
 * @param {string} messageContent – The DM body or URL
 * @param {string} type – The type of message ('text', 'link', 'pdf')
 * @returns {object} API response data
 */
async function sendDirectMessage(accessToken, recipientId, messageContent, type = 'link', commentId = null) {
  const url = `${GRAPH_URL}/me/messages`;

  let messagePayload;

  if (type === 'pdf') {
    messagePayload = {
      attachment: {
        type: 'file',
        payload: {
          url: messageContent,
          is_compressible: true,
        },
      },
    };
  } else {
    // text or link
    messagePayload = { text: messageContent };
  }

  const recipientPayload = commentId ? { comment_id: commentId } : { id: recipientId };

  const payload = {
    recipient: recipientPayload,
    message: messagePayload,
  };

  console.log(`📩 Sending ${type} DM to ${commentId ? 'comment ' + commentId : recipientId}...`);

  const response = await axios.post(url, payload, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
  });

  console.log(`✅ ${type} DM sent successfully to ${recipientId}`);
  return response.data;
}

/**
 * Exchange an authorization code for a short-lived access token.
 *
 * Instagram requires a POST with form-urlencoded body to:
 *   https://api.instagram.com/oauth/access_token
 */
async function exchangeCodeForToken(code) {
  const url = `${FB_GRAPH_URL}/oauth/access_token`;

  const params = new URLSearchParams();
  params.append('client_id', process.env.IG_APP_ID);
  params.append('client_secret', process.env.IG_APP_SECRET);
  params.append('redirect_uri', process.env.REDIRECT_URI);
  params.append('code', code);

  const response = await axios.get(url, { params });

  console.log('🔑 Short-lived user token obtained');
  return response.data; // { access_token, token_type, expires_in }
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
  const url = `${FB_GRAPH_URL}/oauth/access_token`;

  const response = await axios.get(url, {
    params: {
      grant_type: 'fb_exchange_token',
      client_id: process.env.IG_APP_ID,
      client_secret: process.env.IG_APP_SECRET,
      fb_exchange_token: shortLivedToken,
    },
  });

  console.log('🔑 Long-lived user token obtained (60 days)');
  return response.data; // { access_token, token_type, expires_in }
}

/**
 * Gets the Instagram Account ID and the Page Access Token 
 * by checking the Facebook Pages the user manages.
 */
async function getInstagramAccountIdAndToken(userAccessToken) {
  // 1. Get user's pages
  const url = `${FB_GRAPH_URL}/me/accounts`;
  const response = await axios.get(url, {
    params: { access_token: userAccessToken }
  });

  const pages = response.data.data;
  if (!pages || pages.length === 0) throw new Error("No Facebook Pages found");

  // 2. Find a page with a linked Instagram account
  for (const page of pages) {
    const pageToken = page.access_token;
    const igUrl = `${FB_GRAPH_URL}/${page.id}?fields=instagram_business_account&access_token=${pageToken}`;
    try {
      const igRes = await axios.get(igUrl);
      if (igRes.data && igRes.data.instagram_business_account) {
        console.log(`✅ Found linked Instagram Account ID: ${igRes.data.instagram_business_account.id}`);
        return {
          igUserId: igRes.data.instagram_business_account.id,
          accessToken: pageToken
        };
      }
    } catch (e) {
      console.log(`⚠️ Page ${page.id} has no IG account or error fetching`);
    }
  }
  
  throw new Error("No linked Instagram Business/Creator account found on any Facebook Page");
}

async function replyToComment(accessToken, commentId, messageText) {
  const url = `${GRAPH_URL}/${commentId}/replies`;

  const payload = {
    message: messageText,
  };

  console.log(`💬 Replying to comment ${commentId}...`);

  const response = await axios.post(url, payload, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
  });

  console.log(`✅ Reply sent successfully to comment ${commentId}`);
  return response.data;
}

module.exports = {
  sendDirectMessage,
  exchangeCodeForToken,
  exchangeForLongLivedToken,
  getInstagramAccountIdAndToken,
  replyToComment,
};
