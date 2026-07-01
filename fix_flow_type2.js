const fs = require('fs');
let file = fs.readFileSync('src/services/flowRunner.js', 'utf8');
file = file.replace(
  "type: firstMessage.type === 'button_message' ? 'button_message' :",
  "type: firstMessage.type === 'button_message' ? 'button_template' :"
);
file = file.replace(
  "type: currentStep.type === 'button_message' ? 'button_message' :",
  "type: currentStep.type === 'button_message' ? 'button_template' :"
);
fs.writeFileSync('src/services/flowRunner.js', file);
