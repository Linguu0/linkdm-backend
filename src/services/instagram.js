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
async function sendDirectMessage(accessToken, recipientId, messageContent, type = 'link', commentId = null, buttonTemplateData = null, quickRepliesData = null) {
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
  } else if (type === 'button_template' && buttonTemplateData && buttonTemplateData.length > 0) {
    messagePayload = {
      attachment: {
        type: "template",
        payload: {
          template_type: "generic",
          elements: buttonTemplateData.map(slide => {
            const element = {
              title: slide.title || "Message",
            };
            if (slide.image) {
              element.image_url = slide.image;
            }
            
            const btn = {
              title: slide.btnLabel || "Click Here"
            };
            if (slide.destination === 'url') {
              btn.type = "web_url";
              btn.url = slide.url;
            } else if (slide.destination === 'phone') {
              btn.type = "phone_number";
              btn.payload = slide.url;
            } else if (slide.destination === 'email') {
              btn.type = "web_url";
              btn.url = slide.url.startsWith('mailto:') ? slide.url : `mailto:${slide.url}`;
            }
            element.buttons = [btn];
            return element;
          })
        }
      }
    };
  } else if (type === 'quick_replies' && quickRepliesData && quickRepliesData.length > 0) {
    messagePayload = {
      text: messageContent,
      quick_replies: quickRepliesData.map((qr, i) => ({
        content_type: "text",
        title: qr.text,
        payload: `QUICK_REPLY_${i}`
      }))
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

async function replyToComment(accessToken, commentId, messageText) {
  // Use GRAPH_URL because Instagram User Access Tokens (IGAAT) do not work on graph.facebook.com
  const url = `${GRAPH_URL}/${commentId}/replies`;

  const payload = {
    message: messageText,
  };

  console.log(`💬 Replying to comment ${commentId} via Instagram Graph API...`);

  try {
    const response = await axios.post(url, payload, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    });

    console.log(`✅ Reply sent successfully to comment ${commentId}`);
    return response.data;
  } catch (err) {
    const errorMsg = err.response?.data?.error?.message || err.message;
    console.error(`❌ Failed to reply to comment ${commentId}:`, errorMsg);
    throw new Error(errorMsg);
  }
}

module.exports = {
  sendDirectMessage,
  exchangeCodeForToken,
  exchangeForLongLivedToken,
  replyToComment,
};
