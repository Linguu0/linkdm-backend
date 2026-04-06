/**
 * matcher.js — Case-insensitive keyword matching service
 *
 * Checks whether a comment contains a campaign keyword.
 */

/**
 * Determines if the comment text contains the given keyword.
 * Both values are lower-cased for case-insensitive comparison.
 *
 * @param {string} commentText – The raw text of the Instagram comment
 * @param {string} keyword     – The campaign keyword to match against
 * @returns {boolean}
 */
function matchesKeyword(commentText, keyword) {
  if (!commentText || !keyword) return false;

  const normalizedComment = commentText.toLowerCase().trim();

  let keywordArray = [];
  if (Array.isArray(keyword)) {
    keywordArray = keyword;
  } else if (typeof keyword === 'string') {
    try {
      const parsed = JSON.parse(keyword);
      if (Array.isArray(parsed)) {
        keywordArray = parsed;
      } else {
        keywordArray = [keyword];
      }
    } catch (e) {
      keywordArray = [keyword];
    }
  }

  for (const kw of keywordArray) {
    if (typeof kw === 'string' && normalizedComment.includes(kw.toLowerCase().trim())) {
      return true;
    }
  }

  return false;
}

module.exports = { matchesKeyword };
