const fs = require('fs');
let file = fs.readFileSync('src/services/instagram.js', 'utf8');
file = file.replace(
  "const element = {\n              title: slide.title || \"Message\",\n            };",
  "const element = {\n              title: slide.title || \"Message\",\n            };\n            if (slide.subtitle) {\n              element.subtitle = slide.subtitle;\n            }"
);
fs.writeFileSync('src/services/instagram.js', file);
