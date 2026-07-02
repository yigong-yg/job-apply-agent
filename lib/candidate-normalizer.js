'use strict';

// Canonical company/title normalization (spec R5). Repost farms mint new
// jobIds daily, so duplicate detection must key on normalized company+title
// rather than jobId.

const CORPORATE_SUFFIXES = new Set([
  'inc', 'incorporated', 'llc', 'ltd', 'limited', 'corp', 'corporation', 'co',
]);

function baseNormalize(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Normalize a company name: lowercase, strip punctuation, drop trailing
 * corporate suffixes, then apply the optional alias table.
 */
function normalizeCompany(company, aliases = {}) {
  let norm = baseNormalize(company);
  if (!norm) return '';

  const words = norm.split(' ');
  while (words.length > 1 && CORPORATE_SUFFIXES.has(words[words.length - 1])) {
    words.pop();
  }
  norm = words.join(' ');

  return aliases[norm] || norm;
}

/**
 * Normalize a job title: drop parenthetical/bracketed suffixes (locations,
 * requisition tags), lowercase, strip punctuation.
 */
function normalizeTitle(title) {
  const stripped = String(title || '')
    .replace(/\(.*?\)/g, ' ')
    .replace(/\[.*?\]/g, ' ');
  return baseNormalize(stripped);
}

module.exports = { normalizeCompany, normalizeTitle };
