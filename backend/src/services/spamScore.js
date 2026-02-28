const PHRASE_RULES = [
  {
    pattern: /\b(free money|make money fast|double your money|guaranteed income|financial freedom)\b/gi,
    weight: 17,
    reason: 'Money-claim wording looks promotional.',
    improvement: 'Remove earnings or guaranteed-result claims.'
  },
  {
    pattern: /\b(act now|urgent|last chance|limited time|expires today|don'?t miss out)\b/gi,
    weight: 14,
    reason: 'Urgency pressure words detected.',
    improvement: 'Reduce pressure words and use neutral timing.'
  },
  {
    pattern: /\b(winner|congratulations|claim your prize|jackpot|selected for)\b/gi,
    weight: 14,
    reason: 'Prize or winner-style phrasing detected.',
    improvement: 'Avoid lottery/prize style language in outreach emails.'
  },
  {
    pattern: /\b(risk[- ]?free|no risk|100%|guaranteed|promise)\b/gi,
    weight: 12,
    reason: 'Absolute guarantee language detected.',
    improvement: 'Replace absolute claims with specific, verifiable details.'
  },
  {
    pattern: /\b(buy now|order now|click here|visit now|sign up now|register now)\b/gi,
    weight: 11,
    reason: 'Hard-sell call-to-action phrases detected.',
    improvement: 'Use softer, contextual call-to-action wording.'
  },
  {
    pattern: /\b(cheap|lowest price|discount|exclusive offer|special offer|limited deal)\b/gi,
    weight: 9,
    reason: 'Heavy promotional offer language detected.',
    improvement: 'Reduce repeated offer/discount wording.'
  },
  {
    pattern: /\b(bitcoin|crypto profit|loan approved|debt relief|wire transfer)\b/gi,
    weight: 10,
    reason: 'Financial-risk keywords detected.',
    improvement: 'Avoid high-risk finance terms unless essential and contextual.'
  }
];

const SHORTENER_DOMAINS = new Set(['bit.ly', 'tinyurl.com', 't.co', 'goo.gl', 'rb.gy', 'is.gd', 'cutt.ly']);

function toGlobalRegex(pattern) {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  return new RegExp(pattern.source, flags);
}

function countRegexMatches(content, pattern) {
  if (!content) {
    return 0;
  }

  const regex = toGlobalRegex(pattern);
  const matches = content.match(regex);
  return matches ? matches.length : 0;
}

function clampScore(score) {
  return Math.max(0, Math.min(100, Math.round(Number(score) || 0)));
}

function scoreToLabel(score) {
  if (score > 68) {
    return 'High';
  }

  if (score > 36) {
    return 'Medium';
  }

  return 'Low';
}

function normalizeText(value) {
  return String(value || '').replace(/\r\n/g, '\n').trim();
}

function dedupe(list = [], limit = 5) {
  const normalized = list.map((item) => String(item || '').trim()).filter(Boolean);
  return [...new Set(normalized)].slice(0, limit);
}

function addIssue(issues, reason, improvement, score) {
  if (!Number.isFinite(score) || score <= 0) {
    return;
  }

  issues.push({
    reason,
    improvement,
    score
  });
}

function countShortenedUrls(urls) {
  return urls.reduce((total, value) => {
    try {
      const hostname = new URL(value).hostname.toLowerCase();
      return total + (SHORTENER_DOMAINS.has(hostname) ? 1 : 0);
    } catch (_error) {
      return total;
    }
  }, 0);
}

function calculateSpamScore(subject = '', body = '') {
  const subjectText = normalizeText(subject);
  const bodyText = normalizeText(body);
  const content = `${subjectText}\n${bodyText}`.trim();

  if (!content) {
    return {
      score: 0,
      label: 'Low',
      reasons: ['No content yet.'],
      improvements: ['Add subject and body to evaluate spam risk.']
    };
  }

  const issues = [];
  let mitigation = 0;

  for (const rule of PHRASE_RULES) {
    const subjectMatches = countRegexMatches(subjectText, rule.pattern);
    const bodyMatches = countRegexMatches(bodyText, rule.pattern);
    if (!subjectMatches && !bodyMatches) {
      continue;
    }

    const weightedMatches = Math.min(3, bodyMatches + subjectMatches * 1.4);
    addIssue(issues, rule.reason, rule.improvement, Math.round(rule.weight * weightedMatches));
  }

  const urls = content.match(/https?:\/\/[^\s<>"')]+/gi) || [];
  const urlCount = urls.length;
  if (urlCount >= 4) {
    addIssue(
      issues,
      'Too many links can look suspicious to spam filters.',
      'Limit links and keep only essential trusted URLs.',
      19
    );
  } else if (urlCount >= 2) {
    addIssue(issues, 'Multiple links detected in the message.', 'Use fewer links and keep anchor text descriptive.', 12);
  } else if (urlCount === 1) {
    addIssue(issues, 'Single link detected.', 'Ensure the link is relevant and from a trusted domain.', 5);
  }

  const shortenedUrlCount = countShortenedUrls(urls);
  if (shortenedUrlCount > 0) {
    addIssue(
      issues,
      'URL shorteners are commonly flagged by spam filters.',
      'Use full branded domain links instead of shortened URLs.',
      Math.min(16, 8 * shortenedUrlCount)
    );
  }

  const exclamationCount = countRegexMatches(content, /!/g);
  const repeatedPunctuationCount = countRegexMatches(content, /[!?]{2,}/g);
  if (exclamationCount >= 5) {
    addIssue(
      issues,
      'Excessive exclamation marks detected.',
      'Remove excessive punctuation and keep tone professional.',
      12
    );
  } else if (exclamationCount >= 2) {
    addIssue(issues, 'Multiple exclamation marks detected.', 'Use punctuation sparingly.', 5);
  }

  if (repeatedPunctuationCount > 0) {
    addIssue(
      issues,
      'Repeated punctuation (like !! or ??) detected.',
      'Avoid repeated punctuation for better deliverability.',
      7
    );
  }

  const allCapsWords = (content.match(/\b[A-Z0-9]{4,}\b/g) || []).length;
  const letters = content.match(/[A-Za-z]/g) || [];
  const uppercaseLetters = content.match(/[A-Z]/g) || [];
  const uppercaseRatio = letters.length ? uppercaseLetters.length / letters.length : 0;

  if (allCapsWords >= 6 || (uppercaseRatio > 0.55 && letters.length > 40)) {
    addIssue(
      issues,
      'Heavy all-caps usage detected.',
      'Use sentence case instead of all-caps words.',
      14
    );
  } else if (allCapsWords >= 3 || (uppercaseRatio > 0.4 && letters.length > 40)) {
    addIssue(issues, 'Some all-caps usage detected.', 'Reduce all-caps words.', 8);
  }

  const symbolBursts = countRegexMatches(content, /[$€£₹%*#]{3,}/g);
  if (symbolBursts > 0) {
    addIssue(
      issues,
      'High concentration of promotional symbols detected.',
      'Reduce symbols like $$$, %%%, *** in subject/body.',
      8
    );
  }

  if (subjectText.length > 78) {
    addIssue(
      issues,
      'Subject line is too long.',
      'Keep subject concise (ideally under 60-70 characters).',
      8
    );
  }

  if (subjectText.length > 0 && subjectText.length < 3) {
    addIssue(
      issues,
      'Subject line is too short.',
      'Use a clear, meaningful subject instead of very short text.',
      6
    );
  }

  if (bodyText.length > 0 && bodyText.length < 40) {
    addIssue(
      issues,
      'Body content is very short.',
      'Add context and meaningful value in the body text.',
      9
    );
  }

  const promotionalTone =
    /\b(offer|discount|sale|deal|free|buy|claim|limited|register|trial|promo)\b/i.test(content) || urlCount > 0;

  const hasUnsubscribe = /\b(unsubscribe|opt[\s-]?out|manage preferences|email preferences)\b/i.test(bodyText);
  if (promotionalTone && !hasUnsubscribe) {
    addIssue(
      issues,
      'Promotional email without unsubscribe wording.',
      'Add unsubscribe or opt-out instructions in footer.',
      11
    );
  } else if (promotionalTone && hasUnsubscribe) {
    mitigation += 8;
  }

  const hasGreeting = /\b(hi|hello|dear)\b/i.test(bodyText);
  const hasSignOff = /\b(thanks|thank you|regards|sincerely|best)\b/i.test(bodyText);
  if (hasGreeting && hasSignOff) {
    mitigation += 4;
  }

  if (bodyText.length >= 80 && bodyText.length <= 1800) {
    mitigation += 3;
  }

  const rawScore = issues.reduce((total, issue) => total + issue.score, 0) - mitigation;
  const score = clampScore(rawScore);

  const rankedIssues = [...issues].sort((a, b) => b.score - a.score);
  const reasons = dedupe(rankedIssues.map((item) => item.reason), 5);
  const improvements = dedupe(rankedIssues.map((item) => item.improvement), 5);

  return {
    score,
    label: scoreToLabel(score),
    reasons: reasons.length ? reasons : ['Content looks natural and low-risk.'],
    improvements: improvements.length
      ? improvements
      : ['Keep wording clear and include unsubscribe text for promotional campaigns.']
  };
}

module.exports = {
  calculateSpamScore
};
