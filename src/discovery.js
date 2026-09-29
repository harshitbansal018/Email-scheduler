// Global job discovery + recruiter email lookup.
//
// Stage 1: pull job listings from public job APIs (no key required)
// Stage 2: detect required skills in each job description and score against your resume
// Stage 3: look up recruiter emails for the matching companies via Hunter.io (needs HUNTER_API_KEY)
const store = require('./store');
const resume = require('./resume');

const UA = 'Mozilla/5.0 (compatible; personal-job-search)';
const TIMEOUT_MS = 20000;

async function getJson(url, options = {}) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json', ...(options.headers || {}) },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${new URL(url).hostname} returned ${res.status}`);
  return res.json();
}

function stripHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n))
    .replace(/\s+/g, ' ')
    .trim();
}

function matchesQuery(job, terms) {
  if (!terms.length) return true;
  const haystack = `${job.title} ${job.description}`.toLowerCase();
  // Any term matching is enough - job titles vary a lot between companies
  return terms.some((t) => haystack.includes(t));
}

// ---------------- location ----------------

// "India" on a job posting shows up as a city, a state, NCR, or APAC just as often
// as the word "India", so the preset matches all the common spellings.
const LOCATION_PRESETS = {
  india: /\b(india|indian|bharat|bangalore|bengaluru|mumbai|bombay|delhi|new delhi|ncr|gurgaon|gurugram|noida|hyderabad|pune|chennai|madras|kolkata|calcutta|ahmedabad|jaipur|kochi|cochin|indore|chandigarh|coimbatore|nagpur|trivandrum|thiruvananthapuram|vizag|visakhapatnam|mysore|mysuru|bhubaneswar|surat|lucknow|karnataka|maharashtra|telangana|tamil nadu|kerala|gujarat|haryana|uttar pradesh|west bengal|rajasthan|punjab|apac|asia pacific|south asia)\b/i,
  remote: /\b(remote|anywhere|work from home|wfh|distributed|worldwide|global)\b/i,
};

const WORLDWIDE = /\b(anywhere|worldwide|global|any location|no restriction|fully remote)\b/i;

/**
 * A remote job usually still restricts which countries it will hire from, so
 * "remote" alone is not enough - the posting has to be open to where you live.
 * An unstated restriction is treated as open.
 */
function isOpenTo(restrictions, where) {
  const r = String(restrictions || '').trim();
  if (!r) return true;
  if (WORLDWIDE.test(r)) return true;
  const preset = LOCATION_PRESETS[where];
  return preset ? preset.test(r) : r.toLowerCase().includes(where);
}

function matchesLocation(job, locations, eligibleFrom) {
  if (!locations.length) return true;
  const haystack = `${job.location || ''} ${job.locationRestrictions || ''}`;
  return locations.some((loc) => {
    if (loc === 'remote') {
      const isRemote = job.remote || LOCATION_PRESETS.remote.test(haystack);
      if (!isRemote) return false;
      // Drop remote roles that only hire in, say, "USA, Canada"
      return !eligibleFrom || isOpenTo(haystack, eligibleFrom);
    }
    const preset = LOCATION_PRESETS[loc];
    if (preset) return preset.test(haystack);
    return haystack.toLowerCase().includes(loc);
  });
}

// ---------------- experience ----------------

const EXPERIENCE_LEVELS = [
  { key: 'internship', label: 'Internship / Trainee', min: 0, max: 0, title: /\b(intern|internship|trainee|apprentice|co-?op)\b/i },
  { key: 'entry', label: 'Entry level (0-1 yrs)', min: 0, max: 1, title: /\b(entry[- ]level|graduate|fresher|fresh graduate|new grad|campus|junior trainee)\b/i },
  { key: 'junior', label: 'Junior (1-3 yrs)', min: 1, max: 3, title: /\b(junior|jr\.?|associate)\b/i },
  { key: 'mid', label: 'Mid level (3-6 yrs)', min: 3, max: 6, title: /\b(mid[- ]level|intermediate|mid[- ]senior)\b/i },
  { key: 'senior', label: 'Senior (6-10 yrs)', min: 6, max: 10, title: /\b(senior|sr\.?|staff|specialist iii)\b/i },
  { key: 'lead', label: 'Lead / Principal (10+ yrs)', min: 10, max: 99, title: /\b(lead|principal|architect|head of|director|vp|vice president|chief|manager ii)\b/i },
];

function levelFromYears(min) {
  // Pick the band the required minimum falls into
  for (const l of EXPERIENCE_LEVELS) {
    if (min >= l.min && min <= l.max) return l.key;
  }
  return 'lead';
}

// Pull "3+ years", "3-5 years", "minimum 4 years of experience" out of a description
function yearsFromText(text) {
  const window = text.slice(0, 6000);
  const patterns = [
    /(\d{1,2})\s*(?:\+|plus)?\s*(?:-|to|–)\s*(\d{1,2})\s*(?:\+)?\s*years?/gi,
    /(?:minimum|min\.?|at least|least|over|more than)\s*(\d{1,2})\s*(?:\+)?\s*years?/gi,
    /(\d{1,2})\s*\+\s*years?/gi,
    /(\d{1,2})\s*years?\s+(?:of\s+)?(?:relevant\s+|professional\s+|hands[- ]on\s+|work\s+)?experience/gi,
  ];
  const found = [];
  for (const re of patterns) {
    for (const m of window.matchAll(re)) {
      const a = parseInt(m[1], 10);
      const b = m[2] ? parseInt(m[2], 10) : null;
      if (Number.isFinite(a) && a <= 30) found.push({ min: a, max: b && b <= 40 ? b : null });
    }
  }
  if (!found.length) return null;
  // The smallest stated minimum is the real bar to clear
  const min = Math.min(...found.map((f) => f.min));
  const withMax = found.filter((f) => f.max !== null);
  const max = withMax.length ? Math.max(...withMax.map((f) => f.max)) : null;
  return { min, max };
}

/**
 * Works out the experience a job wants, preferring an explicit years figure in the
 * description, then the source's own seniority field, then keywords in the title.
 */
function detectExperience(job) {
  const years = yearsFromText(`${job.description || ''}`);
  if (years) {
    return {
      level: levelFromYears(years.min),
      minYears: years.min,
      maxYears: years.max,
      source: 'description',
    };
  }

  // Some sources (Himalayas) state seniority directly
  if (job.seniority) {
    const s = String(job.seniority).toLowerCase();
    const hit = EXPERIENCE_LEVELS.find((l) => s.includes(l.key) || l.title.test(s));
    if (hit) return { level: hit.key, minYears: hit.min, maxYears: hit.max, source: 'listing' };
  }

  // Longest title keyword wins, so "senior" beats a stray "lead" in "leading team"
  const titleHit = EXPERIENCE_LEVELS.filter((l) => l.title.test(job.title || ''));
  if (titleHit.length) {
    const pick = titleHit[titleHit.length - 1];
    return { level: pick.key, minYears: pick.min, maxYears: pick.max, source: 'title' };
  }

  return { level: 'unknown', minYears: null, maxYears: null, source: 'none' };
}

/**
 * Keeps a job if it suits the candidate's experience.
 * - levels: only these bands (empty = any)
 * - myYears: hide jobs demanding clearly more than the candidate has
 */
function matchesExperience(exp, { levels, myYears }) {
  if (levels.length && exp.level !== 'unknown' && !levels.includes(exp.level)) return false;

  if (myYears !== null && exp.minYears !== null) {
    // One year of slack - postings ask for more than they settle for
    if (exp.minYears > myYears + 1) return false;
  }
  return true;
}

// ---------------- job sources ----------------

async function fromRemotive(query) {
  const url = `https://remotive.com/api/remote-jobs?limit=100${query ? `&search=${encodeURIComponent(query)}` : ''}`;
  const data = await getJson(url);
  return (data.jobs || []).map((j) => ({
    source: 'Remotive',
    externalId: `remotive-${j.id}`,
    title: j.title,
    company: j.company_name,
    location: j.candidate_required_location || 'Remote',
    remote: true,
    url: j.url,
    description: stripHtml(j.description),
    postedAt: j.publication_date,
  }));
}

async function fromArbeitnow() {
  const data = await getJson('https://www.arbeitnow.com/api/job-board-api');
  return (data.data || []).map((j) => ({
    source: 'Arbeitnow',
    externalId: `arbeitnow-${j.slug}`,
    title: j.title,
    company: j.company_name,
    location: j.location || (j.remote ? 'Remote' : ''),
    remote: Boolean(j.remote),
    url: j.url,
    description: stripHtml(j.description) + ' ' + (j.tags || []).join(' '),
    postedAt: j.created_at ? new Date(j.created_at * 1000).toISOString() : null,
  }));
}

// Himalayas states seniority and location restrictions explicitly, which makes it
// the best source for "remote but open to India" roles.
async function fromHimalayas() {
  const data = await getJson('https://himalayas.app/jobs/api?limit=100');
  return (data.jobs || []).map((j) => ({
    source: 'Himalayas',
    externalId: `himalayas-${j.guid}`,
    title: j.title,
    company: j.companyName,
    location: (j.locationRestrictions || []).join(', ') || 'Remote',
    locationRestrictions: (j.locationRestrictions || []).join(', '),
    remote: true,
    url: j.applicationLink,
    description: stripHtml(j.description),
    seniority: (j.seniority || []).join(' '),
    postedAt: j.pubDate ? new Date(j.pubDate * 1000).toISOString() : null,
  }));
}

// Adzuna covers on-site jobs in India properly, but needs a free app id + key
async function fromAdzuna(query, location) {
  const id = process.env.ADZUNA_APP_ID;
  const key = process.env.ADZUNA_APP_KEY;
  if (!id || !key) throw new Error('ADZUNA_APP_ID / ADZUNA_APP_KEY not set (optional)');

  const country = 'in'; // India
  const params = new URLSearchParams({
    app_id: id, app_key: key, results_per_page: '50', 'content-type': 'application/json',
  });
  if (query) params.set('what_or', query.replace(/[,;]/g, ' '));
  if (location && !LOCATION_PRESETS[location.toLowerCase()]) params.set('where', location);

  const data = await getJson(`https://api.adzuna.com/v1/api/jobs/${country}/search/1?${params}`);
  return (data.results || []).map((j) => ({
    source: 'Adzuna (India)',
    externalId: `adzuna-${j.id}`,
    title: j.title,
    company: j.company?.display_name || '',
    location: j.location?.display_name || 'India',
    remote: /remote|work from home/i.test(`${j.title} ${j.description}`),
    url: j.redirect_url,
    description: stripHtml(j.description),
    postedAt: j.created,
  }));
}

async function fromGreenhouse(slug) {
  const data = await getJson(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs?content=true`);
  return (data.jobs || []).map((j) => ({
    source: `Greenhouse:${slug}`,
    externalId: `gh-${slug}-${j.id}`,
    title: j.title,
    company: (data.name || slug),
    location: j.location?.name || '',
    remote: /remote/i.test(j.location?.name || ''),
    url: j.absolute_url,
    description: stripHtml(j.content),
    postedAt: j.updated_at,
  }));
}

async function fromLever(slug) {
  const data = await getJson(`https://api.lever.co/v0/postings/${encodeURIComponent(slug)}?mode=json`);
  if (!Array.isArray(data)) throw new Error('not a Lever board');
  return data.map((j) => ({
    source: `Lever:${slug}`,
    externalId: `lever-${slug}-${j.id}`,
    title: j.text,
    company: slug,
    location: j.categories?.location || '',
    remote: /remote/i.test(j.categories?.location || j.workplaceType || ''),
    url: j.hostedUrl,
    description: stripHtml(j.descriptionPlain || j.description),
    postedAt: j.createdAt ? new Date(j.createdAt).toISOString() : null,
  }));
}

// Company board slugs are tried on Greenhouse first, then Lever
async function fromCompanyBoard(slug) {
  try {
    return await fromGreenhouse(slug);
  } catch {
    return await fromLever(slug);
  }
}

// ---------------- search + match ----------------

/**
 * Searches the configured sources, scores each job against the user's resume skills
 * and returns them ranked best-match first.
 */
async function searchJobs({
  query = '', location = 'india, remote', companies = '',
  minMatch = 0, levels = [], myYears = null, eligibleFrom = 'india', limit = 60,
} = {}) {
  const profile = resume.getProfile();
  const mySkills = (profile.skills || []).map((s) => s.toLowerCase());
  if (mySkills.length === 0) {
    throw new Error('Upload your resume first so we know which skills to match against');
  }

  const terms = query.split(/[,;]/).map((t) => t.trim().toLowerCase()).filter(Boolean);
  const slugs = companies.split(/[,;\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
  const locs = location.split(/[,;]/).map((l) => l.trim().toLowerCase()).filter(Boolean);
  const wantLevels = (levels || []).filter(Boolean);
  const years = myYears === null || myYears === '' ? null : Number(myYears);

  const tasks = [
    fromRemotive(query).catch((e) => ({ _error: `Remotive: ${e.message}` })),
    fromHimalayas().catch((e) => ({ _error: `Himalayas: ${e.message}` })),
    fromArbeitnow().catch((e) => ({ _error: `Arbeitnow: ${e.message}` })),
    ...slugs.map((s) => fromCompanyBoard(s).catch((e) => ({ _error: `${s}: ${e.message}` }))),
  ];
  // Adzuna is only worth calling when the user is after India-based roles
  if (process.env.ADZUNA_APP_ID && locs.some((l) => l === 'india' || !LOCATION_PRESETS[l])) {
    tasks.push(fromAdzuna(query, locs.find((l) => !LOCATION_PRESETS[l]) || '').catch((e) => ({ _error: `Adzuna: ${e.message}` })));
  }

  const results = await Promise.all(tasks);
  const errors = [];
  let jobs = [];
  for (const r of results) {
    if (r && r._error) errors.push(r._error);
    else jobs = jobs.concat(r);
  }

  // Deduplicate by company+title
  const seen = new Set();
  const scored = [];
  const rejected = { location: 0, experience: 0, skills: 0, query: 0 };

  for (const job of jobs) {
    const key = `${(job.company || '').toLowerCase()}|${(job.title || '').toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);

    if (!matchesQuery(job, terms)) { rejected.query++; continue; }
    if (!matchesLocation(job, locs, eligibleFrom)) { rejected.location++; continue; }

    const experience = detectExperience(job);
    if (!matchesExperience(experience, { levels: wantLevels, myYears: years })) { rejected.experience++; continue; }

    // The job description is treated exactly like a resume - run the same skill detector on it
    const required = resume.detectSkills(`${job.title} ${job.description}`);
    const matched = required.filter((s) => mySkills.includes(s.toLowerCase()));
    if (matched.length < minMatch) { rejected.skills++; continue; }

    scored.push({
      id: store.nextId(),
      ...job,
      description: undefined, // keep stored payload small
      seniority: undefined,
      experience,
      requiredSkills: required,
      matchedSkills: matched,
      score: matched.length,
      required: required.length,
    });
  }

  scored.sort((a, b) => b.score - a.score || (b.required ? a.required - b.required : 0));
  const top = scored.slice(0, limit);

  store.write('jobs', { searchedAt: new Date().toISOString(), query, location, jobs: top });
  return { jobs: top, errors, rejected, totalFetched: jobs.length, totalMatched: scored.length };
}

function experienceLevels() {
  return EXPERIENCE_LEVELS.map(({ key, label }) => ({ key, label }));
}

function getJobs() {
  return store.read('jobs', { jobs: [] });
}

// ---------------- Hunter.io ----------------

function hunterKey() {
  const key = process.env.HUNTER_API_KEY;
  if (!key) throw new Error('HUNTER_API_KEY is not set in .env - get a free key at hunter.io');
  return key;
}

async function hunterAccount() {
  const data = await getJson(`https://api.hunter.io/v2/account?api_key=${hunterKey()}`);
  const d = data.data || {};
  const used = d.requests?.searches?.used ?? null;
  const available = d.requests?.searches?.available ?? null;
  return {
    email: d.email,
    plan: d.plan_name,
    creditsUsed: used,
    creditsAvailable: available,
    creditsLeft: available !== null && used !== null ? available - used : null,
    resetDate: d.reset_date,
  };
}

// Titles that indicate someone who actually handles hiring
const RECRUITER_TITLE = /recruit|talent|hiring|human resource|\bhr\b|people ops|people partner|staffing|sourcer/i;

/**
 * Looks up hiring contacts at a company. Hunter accepts a company name when we
 * don't know the domain, so job listings without a domain still work.
 */
async function findRecruiters({ company, domain, limit = 10 }) {
  const params = new URLSearchParams({ api_key: hunterKey(), limit: String(limit), department: 'hr' });
  if (domain) params.set('domain', domain);
  else if (company) params.set('company', company);
  else throw new Error('company or domain is required');

  const data = await getJson(`https://api.hunter.io/v2/domain-search?${params}`);
  const emails = data.data?.emails || [];
  const resolvedDomain = data.data?.domain || domain || null;

  const contacts = emails
    .filter((e) => e.value)
    .map((e) => ({
      name: [e.first_name, e.last_name].filter(Boolean).join(' '),
      email: e.value,
      position: e.position || '',
      confidence: e.confidence ?? null,
      department: e.department || '',
      verification: e.verification?.status || null,
      isRecruiter: RECRUITER_TITLE.test(e.position || '') || e.department === 'hr',
    }))
    // Prefer titles that clearly do hiring, then higher confidence
    .sort((a, b) => Number(b.isRecruiter) - Number(a.isRecruiter) || (b.confidence || 0) - (a.confidence || 0));

  return { domain: resolvedDomain, contacts };
}

/**
 * For each selected job, finds hiring contacts and adds them to the recruiter list
 * with the job's role and required skills attached, so the existing matcher and
 * email template work unchanged.
 */
async function importRecruitersForJobs(jobIds, { perCompany = 2, recruitersOnly = true } = {}) {
  const stored = getJobs().jobs || [];
  const selected = stored.filter((j) => jobIds.includes(j.id));
  if (selected.length === 0) throw new Error('No matching jobs found - run a search first');

  // One Hunter lookup per company, even if several jobs share it
  const byCompany = new Map();
  for (const job of selected) {
    const key = (job.company || '').toLowerCase();
    if (!key) continue;
    if (!byCompany.has(key)) byCompany.set(key, job);
  }

  const recruiters = store.read('recruiters', []);
  const existing = new Set(recruiters.map((r) => r.email.toLowerCase()));
  const report = [];
  let added = 0;

  for (const [, job] of byCompany) {
    try {
      const { domain, contacts } = await findRecruiters({ company: job.company });
      const pool = recruitersOnly ? contacts.filter((c) => c.isRecruiter) : contacts;
      const picked = pool.slice(0, perCompany);

      const fresh = [];
      for (const c of picked) {
        if (existing.has(c.email.toLowerCase())) continue;
        existing.add(c.email.toLowerCase());
        fresh.push({
          id: store.nextId(),
          name: c.name || 'Hiring Team',
          email: c.email,
          company: job.company,
          role: job.title,
          skills: job.requiredSkills || [],
          source: 'hunter',
          position: c.position,
          confidence: c.confidence,
          domain,
          jobUrl: job.url,
          addedAt: new Date().toISOString(),
        });
      }
      recruiters.push(...fresh);
      added += fresh.length;
      report.push({
        company: job.company, role: job.title, domain,
        found: contacts.length, recruiters: pool.length, added: fresh.length,
      });
    } catch (err) {
      report.push({ company: job.company, role: job.title, error: err.message });
    }
  }

  store.write('recruiters', recruiters);
  return { added, companies: byCompany.size, report };
}

module.exports = {
  searchJobs, getJobs, experienceLevels, hunterAccount, findRecruiters, importRecruitersForJobs,
};
