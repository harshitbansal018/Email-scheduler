require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');

const store = require('./src/store');
const resume = require('./src/resume');
const scheduler = require('./src/scheduler');
const matcher = require('./src/matcher');
const mailer = require('./src/mailer');
const discovery = require('./src/discovery');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Wraps async handlers so thrown errors become JSON responses
const wrap = (fn) => (req, res) => fn(req, res).catch((err) => {
  console.error(err);
  res.status(500).json({ error: err.message });
});

function splitSkills(value) {
  if (Array.isArray(value)) return value.map((s) => String(s).trim()).filter(Boolean);
  return String(value || '').split(/[,;]/).map((s) => s.trim()).filter(Boolean);
}

// Treat the untouched .env.example values as "not configured yet"
const PLACEHOLDERS = ['yourname@gmail.com', 'xxxxxxxxxxxxxxxx', 'Your Name'];
function isSet(value) {
  return Boolean(value) && !PLACEHOLDERS.includes(value.trim());
}

// ---------- status ----------
app.get('/api/status', (req, res) => {
  res.json({
    emailConfigured: isSet(process.env.GMAIL_USER) && isSet(process.env.GMAIL_APP_PASSWORD),
    gmailUser: process.env.GMAIL_USER || null,
    myName: process.env.MY_NAME || null,
    hunterConfigured: Boolean(process.env.HUNTER_API_KEY),
    serverTime: new Date().toISOString(),
  });
});

// ---------- global job discovery ----------
app.get('/api/discover/jobs', (req, res) => res.json(discovery.getJobs()));

app.get('/api/discover/levels', (req, res) => res.json(discovery.experienceLevels()));

app.post('/api/discover/search', wrap(async (req, res) => {
  const { query, location, companies, minMatch, levels, myYears, eligibleFrom } = req.body;
  res.json(await discovery.searchJobs({
    query: query || '',
    location: location || 'india, remote',
    companies: companies || '',
    // Blank/false means "show remote jobs even if they only hire in other countries"
    eligibleFrom: eligibleFrom === false ? null : (eligibleFrom || 'india'),
    minMatch: Math.max(0, parseInt(minMatch, 10) || 0),
    levels: Array.isArray(levels) ? levels : [],
    myYears: myYears === '' || myYears === undefined || myYears === null ? null : Number(myYears),
  }));
}));

app.get('/api/hunter/account', wrap(async (req, res) => res.json(await discovery.hunterAccount())));

// Preview hiring contacts at one company without saving anything
app.get('/api/hunter/contacts', wrap(async (req, res) => {
  const { company, domain } = req.query;
  res.json(await discovery.findRecruiters({ company, domain }));
}));

// Spend Hunter credits: find recruiters for the selected jobs and add them to the list
app.post('/api/discover/import', wrap(async (req, res) => {
  const { jobIds, perCompany, recruitersOnly } = req.body;
  if (!Array.isArray(jobIds) || jobIds.length === 0) return res.status(400).json({ error: 'Select at least one job' });
  res.json(await discovery.importRecruitersForJobs(jobIds, {
    perCompany: Math.max(1, parseInt(perCompany, 10) || 2),
    recruitersOnly: recruitersOnly !== false,
  }));
}));

// ---------- resume / profile ----------
app.get('/api/profile', (req, res) => res.json(resume.getProfile()));

app.post('/api/resume', upload.single('resume'), wrap(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const ext = path.extname(req.file.originalname).toLowerCase();
  if (!['.pdf', '.txt'].includes(ext)) return res.status(400).json({ error: 'Only PDF or TXT resumes are supported' });
  const profile = await resume.setResume(req.file.originalname, req.file.buffer);
  res.json(profile);
}));

app.put('/api/profile', (req, res) => {
  const profile = resume.getProfile();
  profile.skills = splitSkills(req.body.skills);
  store.write('profile', profile);
  res.json(profile);
});

// ---------- recruiters ----------
app.get('/api/recruiters', (req, res) => {
  const profile = resume.getProfile();
  const list = store.read('recruiters', []).map((r) => ({
    ...r,
    match: matcher.matchRecruiter(r, profile.skills || []),
  }));
  res.json(list);
});

app.post('/api/recruiters', (req, res) => {
  const list = store.read('recruiters', []);
  const added = [];

  // Bulk: one recruiter per line -> Name | email | Company | Role | skill1, skill2
  if (req.body.bulk) {
    for (const line of String(req.body.bulk).split(/\r?\n/)) {
      if (!line.trim()) continue;
      const [name, email, company, role, skills] = line.split('|').map((s) => (s || '').trim());
      if (!email || !email.includes('@')) continue;
      added.push({ id: store.nextId(), name, email, company, role, skills: splitSkills(skills) });
    }
  } else {
    const { name, email, company, role, skills } = req.body;
    if (!email || !String(email).includes('@')) return res.status(400).json({ error: 'Valid email is required' });
    added.push({ id: store.nextId(), name: name || '', email: String(email).trim(), company: company || '', role: role || '', skills: splitSkills(skills) });
  }

  // Skip duplicates by email
  const existing = new Set(list.map((r) => r.email.toLowerCase()));
  const fresh = added.filter((r) => !existing.has(r.email.toLowerCase()));
  store.write('recruiters', [...list, ...fresh]);
  res.json({ added: fresh.length, skippedDuplicates: added.length - fresh.length });
});

app.put('/api/recruiters/:id', (req, res) => {
  const list = store.read('recruiters', []);
  const idx = list.findIndex((r) => r.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  const { name, email, company, role, skills } = req.body;
  list[idx] = { ...list[idx], name, email, company, role, skills: splitSkills(skills) };
  store.write('recruiters', list);
  res.json(list[idx]);
});

app.delete('/api/recruiters/:id', (req, res) => {
  const list = store.read('recruiters', []);
  store.write('recruiters', list.filter((r) => r.id !== req.params.id));
  res.json({ ok: true });
});

// ---------- email template ----------
app.get('/api/template', (req, res) => res.json(matcher.getTemplate()));

app.put('/api/template', (req, res) => {
  const { subject, body } = req.body;
  if (!subject || !body) return res.status(400).json({ error: 'Subject and body are required' });
  store.write('template', { subject, body });
  res.json({ subject, body });
});

app.post('/api/template/reset', (req, res) => {
  store.write('template', matcher.DEFAULT_TEMPLATE);
  res.json(matcher.DEFAULT_TEMPLATE);
});

// Render the email for one recruiter so the user can see what will be sent
app.get('/api/preview/:recruiterId', (req, res) => {
  const recruiter = store.read('recruiters', []).find((r) => r.id === req.params.recruiterId);
  if (!recruiter) return res.status(404).json({ error: 'Recruiter not found' });
  const profile = resume.getProfile();
  const { matched } = matcher.matchRecruiter(recruiter, profile.skills || []);
  res.json({ to: recruiter.email, matched, ...matcher.buildEmail(recruiter, profile, matched) });
});

// ---------- schedules ----------
app.get('/api/schedules', (req, res) => {
  res.json(scheduler.getSchedules().map((s) => ({
    ...s,
    nextRun: scheduler.nextRun(s.id),
    running: scheduler.isRunning(s.id),
  })));
});

app.post('/api/schedules', (req, res) => {
  const { runAt } = req.body;
  if (!runAt || Number.isNaN(new Date(runAt).getTime())) return res.status(400).json({ error: 'A valid date/time is required' });
  if (new Date(runAt).getTime() <= Date.now()) return res.status(400).json({ error: 'Scheduled time must be in the future' });
  res.json(scheduler.createSchedule(req.body));
});

app.get('/api/schedules/:id/plan', (req, res) => {
  const sched = scheduler.getSchedules().find((s) => s.id === req.params.id);
  if (!sched) return res.status(404).json({ error: 'Not found' });
  const { plan } = scheduler.planRecipients(sched);
  res.json(plan.map((p) => ({
    recruiterId: p.recruiter.id, name: p.recruiter.name, email: p.recruiter.email,
    company: p.recruiter.company, matched: p.matched, score: p.score, skip: p.skip,
  })));
});

app.post('/api/schedules/:id/run', (req, res) => {
  // Manual "run now" - kicks off in background, UI polls logs
  scheduler.runSchedule(req.params.id, { manual: true }).catch((e) => console.error(e));
  res.json({ started: true });
});

app.post('/api/schedules/:id/cancel', (req, res) => {
  const s = scheduler.cancelSchedule(req.params.id);
  if (!s) return res.status(404).json({ error: 'Not found' });
  res.json(s);
});

app.delete('/api/schedules/:id', (req, res) => {
  scheduler.deleteSchedule(req.params.id);
  res.json({ ok: true });
});

// ---------- logs ----------
app.get('/api/logs', (req, res) => res.json(store.read('logs', []).slice(0, 200)));
app.delete('/api/logs', (req, res) => { store.write('logs', []); res.json({ ok: true }); });

// ---------- test email ----------
app.post('/api/test-email', wrap(async (req, res) => {
  await mailer.verify();
  const profile = resume.getProfile();
  const sample = { name: 'Test Recruiter', company: 'Example Corp', role: 'Software Engineer', skills: (profile.skills || []).slice(0, 3) };
  const { matched } = matcher.matchRecruiter(sample, profile.skills || []);
  const email = matcher.buildEmail(sample, profile, matched);
  await mailer.sendMail({
    to: process.env.GMAIL_USER,
    subject: `[TEST] ${email.subject}`,
    text: email.text,
    attachmentPath: resume.getResumePath(),
    attachmentName: profile.resumeOriginalName,
  });
  res.json({ ok: true, sentTo: process.env.GMAIL_USER });
}));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Email scheduler running at http://localhost:${PORT}`);
  if (!isSet(process.env.GMAIL_USER) || !isSet(process.env.GMAIL_APP_PASSWORD)) {
    console.warn('WARNING: GMAIL_USER / GMAIL_APP_PASSWORD not filled in .env - no email can be sent yet');
  }
  if (!process.env.HUNTER_API_KEY) {
    console.log('Note: HUNTER_API_KEY not set - job search works, but recruiter email lookup will not');
  }
  scheduler.init();
});
