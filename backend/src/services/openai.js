const { calculateSpamScore } = require('./spamScore');

function hasOpenAIConfig() {
  return Boolean(process.env.OPENAI_API_KEY);
}

function clampScore(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 0;
  }

  return Math.max(0, Math.min(100, Math.round(numeric)));
}

function scoreToLabel(score) {
  if (score > 65) {
    return 'High';
  }

  if (score > 35) {
    return 'Medium';
  }

  return 'Low';
}

function parseJsonFromContent(content) {
  const text = String(content || '').trim();
  if (!text) {
    throw new Error('Empty OpenAI response content.');
  }

  try {
    return JSON.parse(text);
  } catch (_error) {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return JSON.parse(text.slice(start, end + 1));
    }

    throw new Error('OpenAI response was not valid JSON.');
  }
}

async function callOpenAIJson({ systemPrompt, userPrompt }) {
  if (!hasOpenAIConfig()) {
    throw new Error('OPENAI_API_KEY is not configured.');
  }

  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ]
    })
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => 'OpenAI request failed');
    throw new Error(`OpenAI request failed (${response.status}): ${errorText}`);
  }

  const payload = await response.json();
  const content = payload?.choices?.[0]?.message?.content;
  return parseJsonFromContent(content);
}

function normalizeReasons(items, fallback = []) {
  if (!Array.isArray(items)) {
    return fallback;
  }

  const normalized = items
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    .slice(0, 5);

  return normalized.length ? normalized : fallback;
}

function uniqueReasons(primary = [], secondary = [], limit = 5) {
  const merged = [...primary, ...secondary]
    .map((item) => String(item || '').trim())
    .filter(Boolean);

  return [...new Set(merged)].slice(0, limit);
}

function heuristicSpam(subject, body) {
  const base = calculateSpamScore(subject, body);
  return {
    ...base,
    source: 'heuristic'
  };
}

async function analyzeSpamWithOpenAI({ subject = '', body = '', signature = '', scope = 'full' }) {
  const isSubjectOnly = String(scope || '').toLowerCase() === 'subject';
  const composedBody = isSubjectOnly
    ? ''
    : [String(body || '').trim(), String(signature || '').trim()].filter(Boolean).join('\n\n');
  const heuristic = heuristicSpam(subject, composedBody);

  if (!hasOpenAIConfig()) {
    return heuristic;
  }

  const systemPrompt = `
You are an expert email deliverability analyst.
Evaluate spam risk based on exact wording in subject and body.
The score must change when risky words, punctuation, links, or casing changes.
Return strict JSON only with the requested keys.
`;

  const userPrompt = isSubjectOnly
    ? `
Analyze this email subject line only for spam risk.
Return JSON with keys exactly:
- score: integer 0-100
- label: one of Low, Medium, High
- reasons: string[] max 5
- improvements: string[] max 4

Subject:\n${subject}
`
    : `
Analyze this email draft for spam risk.
Score must depend on the actual words used in both subject and body.
Return JSON with keys exactly:
- score: integer 0-100
- label: one of Low, Medium, High
- reasons: string[] max 5
- improvements: string[] max 4

Subject:\n${subject}\n\nBody:\n${composedBody}
`;

  try {
    const raw = await callOpenAIJson({ systemPrompt, userPrompt });
    const aiScore = clampScore(raw.score);
    const blendedScore = clampScore(Math.round(aiScore * 0.6 + heuristic.score * 0.4));
    const label = ['Low', 'Medium', 'High'].includes(raw.label) ? raw.label : scoreToLabel(blendedScore);
    const reasons = uniqueReasons(normalizeReasons(raw.reasons, []), heuristic.reasons, 5);
    const improvements = uniqueReasons(normalizeReasons(raw.improvements, []), heuristic.improvements, 4);

    return {
      score: blendedScore,
      label,
      reasons,
      improvements,
      source: 'openai+heuristic',
      aiScore,
      heuristicScore: heuristic.score
    };
  } catch (_error) {
    return heuristic;
  }
}

module.exports = {
  hasOpenAIConfig,
  analyzeSpamWithOpenAI
};
