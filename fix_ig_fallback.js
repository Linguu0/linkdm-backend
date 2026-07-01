const fs = require('fs');
let file = fs.readFileSync('src/services/instagram.js', 'utf8');

const newCode = `
  let payload = {
    recipient: { id: recipientId },
    message: messagePayload,
  };

  console.log(\`📩 Attempting to send \${type} DM to \${recipientId} (using ID)...\`);

  try {
    const response = await axios.post(url, payload, {
      headers: {
        Authorization: \`Bearer \${accessToken}\`,
        'Content-Type': 'application/json',
      },
    });
    console.log(\`✅ \${type} DM sent successfully to \${recipientId} (using ID)\`);
    return response.data;
  } catch (err) {
    const errMsg = err.response?.data?.error?.message || err.message;
    console.warn(\`⚠️ Failed to send to ID \${recipientId}: \${errMsg}\`);
    
    if (commentId) {
      console.log(\`🔄 Falling back to comment_id \${commentId}...\`);
      
      // If falling back to comment_id, it MUST be plain text.
      let fallbackText = messageContent;
      if (type === 'button_template' && buttonTemplateData && buttonTemplateData.length > 0) {
        const slide = buttonTemplateData[0];
        fallbackText = \`\${slide.title || 'Message'}\\n\\n\${slide.btnLabel || 'Link'}: \${slide.url || ''}\`;
      }
      
      const fallbackPayload = {
        recipient: { comment_id: commentId },
        message: { text: fallbackText }
      };

      const fallbackResponse = await axios.post(url, fallbackPayload, {
        headers: {
          Authorization: \`Bearer \${accessToken}\`,
          'Content-Type': 'application/json',
        },
      });
      console.log(\`✅ Fallback Text DM sent successfully to comment \${commentId}\`);
      return fallbackResponse.data;
    } else {
      throw err;
    }
  }
`;

file = file.replace(
  /const recipientPayload = commentId[\s\S]*?return response\.data;\n}/,
  newCode + "\n}"
);
fs.writeFileSync('src/services/instagram.js', file);
