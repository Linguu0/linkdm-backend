const fs = require('fs');
let file = fs.readFileSync('src/services/flowRunner.js', 'utf8');
file = file.replace(/button_template/g, 'button_message');
fs.writeFileSync('src/services/flowRunner.js', file);
