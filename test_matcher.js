const { matchesKeyword } = require('./src/services/matcher.js');
console.log(matchesKeyword("link", '["link"]'));
console.log(matchesKeyword("link", '["LINK"]'));
