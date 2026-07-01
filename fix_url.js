const fs = require('fs');
let file = fs.readFileSync('src/services/instagram.js', 'utf8');
file = file.replace(
  "btn.url = slide.url;",
  "let formattedUrl = slide.url || '';\n              if (formattedUrl && !formattedUrl.startsWith('http://') && !formattedUrl.startsWith('https://')) {\n                formattedUrl = 'https://' + formattedUrl;\n              }\n              btn.url = formattedUrl;"
);
fs.writeFileSync('src/services/instagram.js', file);
