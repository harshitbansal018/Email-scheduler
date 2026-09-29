// Matches your skills against each recruiter's required skills and renders the email template
const store = require('./store');

const DEFAULT_TEMPLATE = {
  subject: 'Application for {{role}} at {{company}} - {{myName}}',
  body: `Dear {{recruiterName}},

I hope you are doing well. I came across the {{role}} opening at {{company}} and would like to apply for the position.

My skill set closely matches what you are looking for. In particular, I have hands-on experience with {{matchedSkills}}. My broader technical skills include {{allSkills}}.

I have attached my resume for your review. I would welcome the opportunity to discuss how I can contribute to your team.

Thank you for your time and consideration.

Best regards,
{{myName}}
{{myPhone}}
{{myLinkedin}}`,
};

// Build a lookup of lowercase alias -> canonical skill name from the dictionary
function buildCanonicalMap() {
  const map = new Map();
  const dict = store.read('skills', { skills: [] }).skills || [];
  for (const s of dict) {
    map.set(s.name.toLowerCase(), s.name);
    for (const a of s.aliases || []) map.set(a.toLowerCase(), s.name);
  }
  return map;
}

function canonicalize(list, map) {
  const out = new Set();
  for (const raw of list || []) {
    const key = String(raw).trim().toLowerCase();
    if (!key) continue;
    out.add(map.get(key) || key);
  }
  return out;
}

// Returns { matched: [...], score } for one recruiter against the user's skills
function matchRecruiter(recruiter, mySkills) {
  const map = buildCanonicalMap();
  const mine = canonicalize(mySkills, map);
  const wanted = canonicalize(recruiter.skills, map);
  const matched = [...wanted].filter((s) => {
    // Compare case-insensitively (canonical names keep their display casing)
    return [...mine].some((m) => m.toLowerCase() === s.toLowerCase());
  });
  return { matched, score: matched.length, wanted: wanted.size };
}

function joinList(items) {
  if (!items || items.length === 0) return '';
  if (items.length === 1) return items[0];
  return items.slice(0, -1).join(', ') + ' and ' + items[items.length - 1];
}

function render(str, vars) {
  return str.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => (vars[key] ?? ''));
}

function getTemplate() {
  return store.read('template', DEFAULT_TEMPLATE);
}

// Produces { subject, text } for a recruiter
function buildEmail(recruiter, profile, matched) {
  const template = getTemplate();
  const vars = {
    recruiterName: recruiter.name || 'Hiring Manager',
    company: recruiter.company || 'your company',
    role: recruiter.role || 'the open position',
    matchedSkills: joinList(matched.length ? matched : profile.skills.slice(0, 5)),
    allSkills: joinList(profile.skills),
    myName: process.env.MY_NAME || '',
    myPhone: process.env.MY_PHONE || '',
    myLinkedin: process.env.MY_LINKEDIN || '',
    myEmail: process.env.GMAIL_USER || '',
  };
  return {
    subject: render(template.subject, vars),
    text: render(template.body, vars),
  };
}

module.exports = { matchRecruiter, buildEmail, getTemplate, DEFAULT_TEMPLATE };
