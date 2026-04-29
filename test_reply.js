require('dotenv').config();
const { replyToComment } = require('./src/services/instagram');

async function test() {
  const accessToken = process.env.ACCESS_TOKEN;
  const commentId = '18407043337199454';
  const url = `https://graph.instagram.com/v21.0/${commentId}/replies`;
  try {
    const axios = require('axios');
    const res = await axios.post(url, { message: 'Test reply 🤖' }, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    console.log('REPLY SUCCESS:', res.data);
  } catch (e) {
    console.error('REPLY FAILED:', e.response?.data || e.message);
  }
}

test();
