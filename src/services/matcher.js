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
  const normalizedKeyword = keyword.toLowerCase().trim();

  return normalizedComment.includes(normalizedKeyword);
}

module.exports = { matchesKeyword };
