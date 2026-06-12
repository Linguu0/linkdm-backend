const scopes = [
  'instagram_business_basic',
  'instagram_business_manage_messages',
  'instagram_business_manage_comments',
].join(',');
const IG_APP_ID = process.env.IG_APP_ID || '123456789';
const REDIRECT_URI = process.env.REDIRECT_URI || 'https://linkdm-backend.onrender.com/auth/callback';

const authUrl = `https://www.instagram.com/oauth/authorize?client_id=${IG_APP_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=${scopes}&response_type=code`;
console.log(authUrl);
