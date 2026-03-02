'use strict';

const crypto = require('crypto');

const FALLBACK_ANSWER = "I'd welcome the opportunity to discuss this in detail during an interview.";
const API_TIMEOUT_MS = 5000;
const API_URL = 'https://api.deepseek.com/chat/completions';
const MODEL = 'deepseek-chat';

/**
 * Build a user context string from config.json and defaultAnswers.json.
 * This gets prepended to every LLM system prompt so the model knows the
 * applicant's real profile data (no placeholders).
 *
 * @param {object} config - full config.json
 * @param {object} defaultAnswers - defaultAnswers.json (.defaultAnswers or flat)
 * @returns {string}
 */
function buildUserContext(config, defaultAnswers) {
  const user = config.user || {};
  const da = defaultAnswers.defaultAnswers || defaultAnswers || {};

  const linkedinUrl = user.linkedinUrl || da['linkedin profile'] || da['linkedin'] || '';
  const githubUrl = da['github'] || da['github profile'] || '';
  const website = da['website'] || da['portfolio'] || '';
  const yearsExp = user.yearsOfExperience || da['years of experience'] || '3';
  const education = user.highestEducation || da['highest level of education'] || "Master's Degree";
  const currentTitle = da['current job title'] || da['current title'] || 'Data Scientist';
  const salary = user.desiredSalary || da['desired salary'] || da['salary expectations'] || '120000';

  return `You are filling out a job application form for the following person.

APPLICANT PROFILE:
- Name: ${user.firstName || ''} ${user.lastName || ''}
- Email: ${user.email || ''}
- Phone: ${user.phone || ''}
- Location: ${user.city || ''}, ${user.state || ''} ${user.zipCode || ''}, United States
- LinkedIn: ${linkedinUrl}
- GitHub: ${githubUrl}
- Website: ${website || 'N/A'}
- Years of Experience: ${yearsExp}
- Education: ${education}
- Current Title: ${currentTitle}
- Desired Salary: ${salary}
- Work Authorization: ${user.workAuthorization || 'Authorized to work in the US'}, ${user.requiresSponsorship ? 'needs sponsorship' : 'no sponsorship needed'}
- Willing to relocate: ${user.willingToRelocate ? 'Yes' : 'No'}

IMPORTANT RULES:
- Use the EXACT values above. Never use placeholders like [handle] or [your-name].
- For LinkedIn URL, always use exactly: ${linkedinUrl}
- For GitHub URL, always use exactly: ${githubUrl}
- For yes/no questions about willingness, availability, or authorization: answer "Yes"
- For years of experience with specific tools: answer "${yearsExp}" if unsure
- For salary questions: answer "${salary}"
- Keep answers concise and direct.
- If it's a text field, give a direct answer. If it's a selection, give the option text to select.`;
}

const LONG_RULES = `
Write a concise, professional answer to the application question below.
Rules:
- Keep it under 150 words
- Be specific but honest — do not fabricate experiences
- Write in first person
- Sound natural and enthusiastic, not robotic
- If the question is about motivation, connect genuine interest in the role/company
- Core skills: Python, SQL, machine learning, deep learning, NLP, data analysis, statistical modeling
- Tools: TensorFlow, PyTorch, scikit-learn, pandas, Spark, AWS, Git
- Strengths: translating business problems into data solutions, building production ML pipelines`;

const SHORT_RULES = `Answer in 1-2 sentences. Max 30 words. Be direct. If yes/no, just "Yes" or "No" then brief context.`;

// Module-level user context — set once via setUserContext(), used in all subsequent calls
let _userContext = '';

/**
 * Initialize the user context for all LLM calls in this process.
 * Call once at startup from index.js after loading config + defaultAnswers.
 *
 * @param {object} config
 * @param {object} defaultAnswers
 */
function setUserContext(config, defaultAnswers) {
  _userContext = buildUserContext(config, defaultAnswers);
}

/**
 * Create a per-run LLM answer cache.
 * Key = SHA-256 of normalized question text.
 * @returns {Map<string, string>}
 */
function createLLMCache() {
  return new Map();
}

/**
 * Compute a mode-aware cache key from a question label.
 * Prevents short/long answer collisions for the same question.
 * @param {string} label
 * @param {string} mode - 'short' or 'long'
 * @returns {string}
 */
function cacheKey(label, mode = 'long') {
  return crypto.createHash('sha256').update(`${mode}:${label.toLowerCase().trim()}`).digest('hex');
}

/**
 * Generate an answer to a free-text application question using DeepSeek API.
 *
 * Gated on process.env.API_KEY — returns fallback immediately if unset.
 * Uses a 5-second timeout and returns fallback on ANY failure.
 *
 * @param {string} questionLabel - the form field question text
 * @param {{ jobTitle?: string, company?: string, jobDescription?: string }} jobContext
 * @param {Map<string, string>} cache - per-run cache (mutated)
 * @param {object} logger - pino logger
 * @param {'short'|'long'} [mode='long'] - short mode uses 50 tokens, long uses 200
 * @returns {Promise<string>}
 */
async function generateAnswer(questionLabel, jobContext = {}, cache = new Map(), logger = console, mode = 'long') {
  const apiKey = process.env.API_KEY;
  if (!apiKey) {
    logger.debug({ question: questionLabel }, 'LLM skipped — no API_KEY set');
    return FALLBACK_ANSWER;
  }

  // Check cache (mode-aware key)
  const key = cacheKey(questionLabel, mode);
  if (cache.has(key)) {
    logger.debug({ question: questionLabel, mode }, 'LLM cache hit');
    return cache.get(key);
  }

  // Build system prompt: user context + mode-specific rules
  const modeRules = mode === 'short' ? SHORT_RULES : LONG_RULES;
  const systemPrompt = _userContext
    ? `${_userContext}\n\n${modeRules}`
    : `You are filling out a job application for a Data Scientist with a Master's degree and 3 years of experience.\n\n${modeRules}`;

  const maxTokens = mode === 'short' ? 50 : 200;

  // Build user message with job context
  const contextParts = [];
  if (jobContext.jobTitle) contextParts.push(`Job title: ${jobContext.jobTitle}`);
  if (jobContext.company) contextParts.push(`Company: ${jobContext.company}`);
  if (jobContext.jobDescription) {
    contextParts.push(`Job description (excerpt): ${jobContext.jobDescription.substring(0, 500)}`);
  }

  const userMessage = contextParts.length > 0
    ? `${contextParts.join('\n')}\n\nQuestion: ${questionLabel}`
    : `Question: ${questionLabel}`;

  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
        max_tokens: maxTokens,
        temperature: 0.7,
      }),
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      logger.warn({ status: response.status, body: errText.substring(0, 200) }, 'LLM API error — using fallback');
      cache.set(key, FALLBACK_ANSWER);
      return FALLBACK_ANSWER;
    }

    const data = await response.json();
    const answer = data.choices?.[0]?.message?.content?.trim();

    if (!answer) {
      logger.warn('LLM returned empty answer — using fallback');
      cache.set(key, FALLBACK_ANSWER);
      return FALLBACK_ANSWER;
    }

    cache.set(key, answer);
    logger.info({ question: questionLabel.substring(0, 80), answerLength: answer.length, mode }, 'LLM generated answer');
    return answer;

  } catch (err) {
    logger.warn({ error: err.message, question: questionLabel.substring(0, 80) }, 'LLM call failed — using fallback');
    cache.set(key, FALLBACK_ANSWER);
    return FALLBACK_ANSWER;
  }
}

module.exports = {
  generateAnswer,
  createLLMCache,
  setUserContext,
  FALLBACK_ANSWER,
};
