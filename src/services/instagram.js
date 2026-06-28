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
            if (slide.subtitle) {
              element.subtitle = slide.subtitle;
            }
            if (slide.image) {
              element.image_url = slide.image;
            }
            
            const btn = {
              title: slide.btnLabel || "Click Here"
            };
            if (slide.destination === 'url') {
              btn.type = "web_url";
              let formattedUrl = slide.url || '';
              if (formattedUrl && !formattedUrl.startsWith('http://') && !formattedUrl.startsWith('https://')) {
                formattedUrl = 'https://' + formattedUrl;
              }
              btn.url = formattedUrl;
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

  
  let payload = {
    recipient: { id: recipientId },
    message: messagePayload,
  };

  console.log(`📩 Attempting to send ${type} DM to ${recipientId} (using ID)...`);

  try {
    const response = await axios.post(url, payload, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    });
    console.log(`✅ ${type} DM sent successfully to ${recipientId} (using ID)`);
    return response.data;
  } catch (err) {
    const errMsg = err.response?.data?.error?.message || err.message;
    console.warn(`⚠️ Failed to send to ID ${recipientId}: ${errMsg}`);
    
    if (commentId) {
      console.log(`🔄 Falling back to comment_id ${commentId}...`);
      
      // If falling back to comment_id, it MUST be plain text.
      let fallbackText = messageContent;
      if (type === 'button_template' && buttonTemplateData && buttonTemplateData.length > 0) {
        const slide = buttonTemplateData[0];
        fallbackText = `${slide.title || 'Message'}\n\n${slide.btnLabel || 'Link'}: ${slide.url || ''}`;
      }
      
      const fallbackPayload = {
        recipient: { comment_id: commentId },
        message: { text: fallbackText }
      };

      const fallbackResponse = await axios.post(url, fallbackPayload, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
      });
      console.log(`✅ Fallback Text DM sent successfully to comment ${commentId}`);
      return fallbackResponse.data;
    } else {
      throw err;
    }
  }

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

/**
 * Check if a user follows the Instagram page.
 *
 * Uses a multi-attempt strategy to maximize accuracy:
 *   1. Try graph.facebook.com (primary, correct endpoint for IGSID lookups)
 *   2. If unknown → retry after a short delay (API may need time after comment interaction)
 *   3. If still unknown → try graph.instagram.com as fallback
 *
 * Returns:
 *   { status: 'yes' }     — confirmed follower → allow DM
 *   { status: 'no' }      — confirmed non-follower → block DM
 *   { status: 'unknown' } — all attempts failed → caller decides (rare after 3 tries)
 *
 * @param {string} accessToken – Page/user access token
 * @param {string} userId – IGSID of the user to check
 * @returns {Promise<{status: 'yes'|'no'|'unknown', reason?: string}>}
 */
async function isFollower(accessToken, userId) {
  // --- Attempt 1: Instagram Graph API (primary) ---
  const result1 = await _checkFollowerViaAPI(GRAPH_URL, accessToken, userId, 'IG-attempt-1');
  if (result1.status === 'yes' || result1.status === 'no') return result1;

  // --- Attempt 2: Retry IG after a short delay (gives API time to register context) ---
  await new Promise(resolve => setTimeout(resolve, 1500));
  const result2 = await _checkFollowerViaAPI(GRAPH_URL, accessToken, userId, 'IG-attempt-2');
  if (result2.status === 'yes' || result2.status === 'no') return result2;

  // --- Attempt 3: Fallback to Facebook Graph API ---
  const result3 = await _checkFollowerViaAPI(FB_GRAPH_URL, accessToken, userId, 'FB-fallback');
  if (result3.status === 'yes' || result3.status === 'no') return result3;

  // All 3 attempts returned unknown
  console.warn(`⚠️ All 3 follower check attempts returned unknown for ${userId}`);
  return { status: 'unknown', reason: 'all_attempts_failed' };
}

/**
 * Internal helper — single API call to check follower status.
 */
async function _checkFollowerViaAPI(baseUrl, accessToken, userId, label) {
  try {
    const url = `${baseUrl}/${userId}`;
    console.log(`👤 [${label}] Checking: GET ${url}?fields=is_user_follow_business`);

    const response = await axios.get(url, {
      params: {
        fields: 'is_user_follow_business',
        access_token: accessToken,
      },
      timeout: 10000,
    });

    const followsYou = response.data?.is_user_follow_business;
    
    if (followsYou === true) {
      console.log(`👤 [${label}] ${userId}: ✅ IS follower`);
      return { status: 'yes' };
    }
    if (followsYou === false) {
      console.log(`👤 [${label}] ${userId}: ❌ NOT a follower`);
      return { status: 'no' };
    }

    console.warn(`👤 [${label}] ${userId}: field not returned — unknown`);
    return { status: 'unknown', reason: 'field_not_returned' };
  } catch (err) {
    const errMsg = err.response?.data?.error?.message || err.message;
    const errCode = err.response?.data?.error?.code;
    console.error(`❌ [${label}] Failed for ${userId}: [code=${errCode}] ${errMsg}`);
    return { status: 'unknown', reason: errMsg };
  }
}

module.exports = {
  sendDirectMessage,
  exchangeCodeForToken,
  exchangeForLongLivedToken,
  replyToComment,
  isFollower,
};
