// Small vanilla-JS frontend for the scheduler API
const $ = (sel) => document.querySelector(sel);

let profile = { skills: [], detectedSkills: [] };
let recruiters = [];

// ---------- helpers ----------
async function api(url, options = {}) {
  const res = await fetch(url, {
    headers: options.body && !(options.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {},
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function toast(msg, isError = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `toast${isError ? ' error' : ''}`;
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.add('hidden'), 3500);
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function openModal(title, html) {
  $('#modalTitle').textContent = title;
  $('#modalBody').innerHTML = html;
  $('#modal').classList.remove('hidden');
}
$('#modalClose').onclick = () => $('#modal').classList.add('hidden');
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') $('#modal').classList.add('hidden'); });

async function run(fn) {
  try { await fn(); } catch (err) { toast(err.message, true); }
}

// ---------- status ----------
async function loadStatus() {
  const s = await api('/api/status');
  const gmail = s.emailConfigured
    ? `<span class="badge ok">Gmail connected</span><span class="muted">${esc(s.gmailUser)}</span>`
    : `<span class="badge bad">Gmail not configured</span><span class="muted">Fill in .env and restart</span>`;
  const hunter = s.hunterConfigured
    ? '<span class="badge ok">Hunter connected</span>'
    : '<span class="badge warn">No Hunter key</span>';
  $('#status').innerHTML = gmail + hunter;
}

// ---------- global discovery ----------
let foundJobs = [];

let levelLabels = {};

async function loadLevels() {
  const levels = await api('/api/discover/levels');
  levelLabels = Object.fromEntries(levels.map((l) => [l.key, l.label]));
  document.querySelector('#searchForm [name=levels]').innerHTML =
    levels.map((l) => `<option value="${l.key}">${esc(l.label)}</option>`).join('');
}

// Shows the detected experience requirement, e.g. "Mid level · 3-6 yrs"
function expCell(exp) {
  if (!exp || exp.level === 'unknown') return '<span class="muted">not stated</span>';
  const label = (levelLabels[exp.level] || exp.level).replace(/\s*\(.*\)$/, '');
  let yrs = '';
  if (exp.minYears !== null) {
    yrs = exp.maxYears && exp.maxYears !== exp.minYears ? `${exp.minYears}–${exp.maxYears} yrs` : `${exp.minYears}+ yrs`;
  }
  const from = exp.source === 'description' ? 'stated in the job description' : `guessed from the ${exp.source}`;
  return `<span title="${esc(from)}">${esc(label)}${yrs ? `<br><small class="muted">${yrs}</small>` : ''}</span>`;
}

function renderJobs() {
  const tbody = $('#jobTable tbody');
  tbody.innerHTML = foundJobs.map((j) => `
    <tr>
      <td><input type="checkbox" class="jobPick" value="${j.id}" checked /></td>
      <td><a href="${esc(j.url)}" target="_blank" rel="noopener">${esc(j.title)}</a></td>
      <td>${esc(j.company)}</td>
      <td>${esc(j.location || '—')}</td>
      <td>${expCell(j.experience)}</td>
      <td><span class="badge ${j.score >= 5 ? 'ok' : 'warn'}">${j.score}/${j.required}</span></td>
      <td>${esc(j.matchedSkills.join(', '))}</td>
      <td class="muted">${esc(j.source)}</td>
    </tr>`).join('');
  $('#jobResults').classList.toggle('hidden', foundJobs.length === 0);
}

async function loadHunterInfo() {
  try {
    const a = await api('/api/hunter/account');
    $('#hunterInfo').textContent = a.creditsLeft !== null
      ? `Hunter: ${a.creditsLeft} credits left of ${a.creditsAvailable} (${a.plan})`
      : `Hunter connected (${a.plan})`;
  } catch (err) {
    $('#hunterInfo').textContent = `Hunter: ${err.message}`;
  }
}

$('#searchForm').onsubmit = (e) => {
  e.preventDefault();
  run(async () => {
    const btn = $('#searchBtn');
    btn.disabled = true;
    $('#searchInfo').textContent = 'Searching job boards…';
    try {
      const form = e.target;
      const r = await api('/api/discover/search', {
        method: 'POST',
        body: JSON.stringify({
          query: form.query.value,
          location: form.location.value,
          companies: form.companies.value,
          minMatch: form.minMatch.value,
          myYears: form.myYears.value,
          eligibleFrom: form.eligibleFrom.checked ? 'india' : false,
          levels: [...form.levels.selectedOptions].map((o) => o.value),
        }),
      });
      foundJobs = r.jobs;
      renderJobs();
      const rej = r.rejected || {};
      $('#searchInfo').innerHTML = `Scanned <strong>${r.totalFetched}</strong> jobs · <strong>${r.totalMatched}</strong> matched · showing top ${r.jobs.length}`
        + `<br><span class="muted">Filtered out: ${rej.query || 0} wrong role, ${rej.location || 0} wrong location, ${rej.experience || 0} wrong experience, ${rej.skills || 0} too few skills</span>`
        + (r.errors.length ? `<br><span class="muted">Some sources failed: ${esc(r.errors.join('; '))}</span>` : '');
      if (r.jobs.length === 0) toast('No jobs matched — try lowering "min matching skills" or widening the location', true);
      await loadHunterInfo();
    } finally {
      btn.disabled = false;
    }
  });
};

$('#selectAllJobs').onclick = () => document.querySelectorAll('.jobPick').forEach((c) => { c.checked = true; });
$('#selectNoneJobs').onclick = () => document.querySelectorAll('.jobPick').forEach((c) => { c.checked = false; });

$('#findEmails').onclick = () => run(async () => {
  const ids = [...document.querySelectorAll('.jobPick:checked')].map((c) => c.value);
  if (ids.length === 0) throw new Error('Select at least one job');
  const companies = new Set(foundJobs.filter((j) => ids.includes(j.id)).map((j) => j.company.toLowerCase()));
  if (!confirm(`This will use about ${companies.size} Hunter credit(s) (one per company, ${companies.size} companies across ${ids.length} jobs). Continue?`)) return;

  const btn = $('#findEmails');
  btn.disabled = true;
  $('#hunterInfo').textContent = 'Looking up recruiters…';
  try {
    const r = await api('/api/discover/import', {
      method: 'POST',
      body: JSON.stringify({
        jobIds: ids,
        perCompany: $('#perCompany').value,
        recruitersOnly: $('#recruitersOnly').checked,
      }),
    });
    const rows = r.report.map((x) => `
      <tr>
        <td>${esc(x.company)}<br><small class="muted">${esc(x.role || '')}</small></td>
        <td>${esc(x.domain || '—')}</td>
        <td>${x.error ? `<span class="badge bad">${esc(x.error)}</span>` : `${x.found} found · ${x.recruiters} HR · <strong>${x.added} added</strong>`}</td>
      </tr>`).join('');
    openModal(`Added ${r.added} recruiter(s) from ${r.companies} company(ies)`, `
      <table><thead><tr><th>Company</th><th>Domain</th><th>Result</th></tr></thead><tbody>${rows}</tbody></table>`);
    await loadRecruiters();
    await loadHunterInfo();
  } finally {
    btn.disabled = false;
  }
});

// ---------- resume / skills ----------
async function loadProfile() {
  profile = await api('/api/profile');
  $('#skills').value = (profile.skills || []).join(', ');
  $('#resumeInfo').textContent = profile.resumeOriginalName
    ? `Current: ${profile.resumeOriginalName} (uploaded ${fmtDate(profile.uploadedAt)})`
    : 'No resume uploaded yet';
  $('#skillsInfo').textContent = profile.detectedSkills?.length
    ? `${profile.detectedSkills.length} skills detected from resume`
    : '';
}

$('#uploadResume').onclick = () => run(async () => {
  const file = $('#resumeFile').files[0];
  if (!file) throw new Error('Choose a PDF or TXT file first');
  const fd = new FormData();
  fd.append('resume', file);
  profile = await api('/api/resume', { method: 'POST', body: fd });
  // Show freshly detected skills in the editor so the user can review them
  $('#skills').value = (profile.detectedSkills || []).join(', ');
  await api('/api/profile', { method: 'PUT', body: JSON.stringify({ skills: profile.detectedSkills }) });
  await loadProfile();
  await loadRecruiters();
  toast(`Resume uploaded — ${profile.detectedSkills.length} skills detected`);
});

$('#saveSkills').onclick = () => run(async () => {
  await api('/api/profile', { method: 'PUT', body: JSON.stringify({ skills: $('#skills').value }) });
  await loadProfile();
  await loadRecruiters();
  toast('Skills saved');
});

$('#resetSkills').onclick = () => run(async () => {
  await api('/api/profile', { method: 'PUT', body: JSON.stringify({ skills: profile.detectedSkills || [] }) });
  await loadProfile();
  await loadRecruiters();
  toast('Skills reset to detected list');
});

// ---------- recruiters ----------
function matchBadge(m) {
  if (!m || m.wanted === 0) return '<span class="badge neutral">no skills listed</span>';
  const cls = m.score === 0 ? 'bad' : m.score >= Math.ceil(m.wanted / 2) ? 'ok' : 'warn';
  return `<span class="badge ${cls}" title="${esc(m.matched.join(', '))}">${m.score}/${m.wanted}</span>`;
}

async function loadRecruiters() {
  recruiters = await api('/api/recruiters');
  const tbody = $('#recruiterTable tbody');
  tbody.innerHTML = recruiters.map((r) => `
    <tr>
      <td>${esc(r.name)}</td>
      <td>${esc(r.email)}</td>
      <td>${esc(r.company)}</td>
      <td>${esc(r.role)}</td>
      <td>${esc((r.skills || []).join(', '))}</td>
      <td>${matchBadge(r.match)}</td>
      <td class="actions">
        <button class="small secondary" data-preview="${r.id}">Preview</button>
        <button class="small secondary danger" data-del="${r.id}">Delete</button>
      </td>
    </tr>`).join('');
  $('#recruiterEmpty').classList.toggle('hidden', recruiters.length > 0);

  // Refresh recruiter picker in the schedule form
  const sel = document.querySelector('#scheduleForm [name=recruiterIds]');
  sel.innerHTML = recruiters.map((r) => `<option value="${r.id}">${esc(r.name || r.email)}${r.company ? ' — ' + esc(r.company) : ''}</option>`).join('');
}

$('#recruiterTable').addEventListener('click', (e) => {
  const del = e.target.dataset.del;
  const prev = e.target.dataset.preview;
  if (del) run(async () => {
    if (!confirm('Delete this recruiter?')) return;
    await api(`/api/recruiters/${del}`, { method: 'DELETE' });
    await loadRecruiters();
  });
  if (prev) run(async () => {
    const p = await api(`/api/preview/${prev}`);
    openModal(`Preview → ${p.to}`, `
      <p><strong>Subject:</strong> ${esc(p.subject)}</p>
      <p class="muted">Matched skills: ${esc(p.matched.join(', ') || 'none')}</p>
      <pre>${esc(p.text)}</pre>`);
  });
});

$('#recruiterForm').onsubmit = (e) => {
  e.preventDefault();
  run(async () => {
    const data = Object.fromEntries(new FormData(e.target).entries());
    await api('/api/recruiters', { method: 'POST', body: JSON.stringify(data) });
    e.target.reset();
    await loadRecruiters();
    toast('Recruiter added');
  });
};

$('#bulkImport').onclick = () => run(async () => {
  const bulk = $('#bulk').value.trim();
  if (!bulk) throw new Error('Paste some lines first');
  const r = await api('/api/recruiters', { method: 'POST', body: JSON.stringify({ bulk }) });
  $('#bulk').value = '';
  await loadRecruiters();
  toast(`Imported ${r.added} recruiter(s)${r.skippedDuplicates ? `, ${r.skippedDuplicates} duplicate(s) skipped` : ''}`);
});

// ---------- template ----------
async function loadTemplate() {
  const t = await api('/api/template');
  $('#tplSubject').value = t.subject;
  $('#tplBody').value = t.body;
}

$('#saveTemplate').onclick = () => run(async () => {
  await api('/api/template', { method: 'PUT', body: JSON.stringify({ subject: $('#tplSubject').value, body: $('#tplBody').value }) });
  toast('Template saved');
});

$('#resetTemplate').onclick = () => run(async () => {
  await api('/api/template/reset', { method: 'POST' });
  await loadTemplate();
  toast('Template reset');
});

$('#testEmail').onclick = () => run(async () => {
  const btn = $('#testEmail');
  btn.disabled = true;
  $('#tplInfo').textContent = 'Sending…';
  try {
    const r = await api('/api/test-email', { method: 'POST' });
    toast(`Test email sent to ${r.sentTo}`);
  } finally {
    btn.disabled = false;
    $('#tplInfo').textContent = '';
  }
});

// ---------- schedules ----------
function statusBadge(s) {
  const map = { pending: 'ok', done: 'neutral', missed: 'warn', cancelled: 'bad' };
  const label = s.running ? 'sending…' : s.status;
  return `<span class="badge ${s.running ? 'warn' : map[s.status] || 'neutral'}">${esc(label)}</span>`;
}

async function loadSchedules() {
  const list = await api('/api/schedules');
  const tbody = $('#scheduleTable tbody');
  tbody.innerHTML = list.map((s) => {
    const who = s.recruiterIds?.length ? `${s.recruiterIds.length} selected` : 'all';
    const filter = `min ${s.minMatch} match · max ${s.maxPerRun} · ${who}${s.skipContacted ? ' · skip contacted' : ''}`;
    const sent = s.lastSummary ? `${s.sentTotal} total<br><small class="muted">last: ${s.lastSummary.sent} sent, ${s.lastSummary.failed} failed, ${s.lastSummary.skipped} skipped</small>` : s.sentTotal || 0;
    return `
    <tr>
      <td>${esc(s.name)}</td>
      <td>${fmtDate(s.runAt)}</td>
      <td>${esc(s.repeat)}</td>
      <td class="muted">${esc(filter)}</td>
      <td>${statusBadge(s)}</td>
      <td>${fmtDate(s.nextRun)}</td>
      <td>${sent}</td>
      <td class="actions">
        <button class="small secondary" data-plan="${s.id}">Who gets it?</button>
        <button class="small" data-run="${s.id}" ${s.running ? 'disabled' : ''}>Run now</button>
        ${s.status === 'pending' ? `<button class="small secondary" data-cancel="${s.id}">Cancel</button>` : ''}
        <button class="small secondary danger" data-delete="${s.id}">Delete</button>
      </td>
    </tr>`;
  }).join('');
  $('#scheduleEmpty').classList.toggle('hidden', list.length > 0);
}

$('#scheduleForm').onsubmit = (e) => {
  e.preventDefault();
  run(async () => {
    const form = e.target;
    const data = {
      name: form.name.value,
      runAt: form.runAt.value,
      repeat: form.repeat.value,
      minMatch: form.minMatch.value,
      maxPerRun: form.maxPerRun.value,
      skipContacted: form.skipContacted.checked,
      recruiterIds: [...form.recruiterIds.selectedOptions].map((o) => o.value),
    };
    await api('/api/schedules', { method: 'POST', body: JSON.stringify(data) });
    form.reset();
    form.minMatch.value = 1;
    form.maxPerRun.value = 50;
    await loadSchedules();
    toast('Schedule added');
  });
};

$('#scheduleTable').addEventListener('click', (e) => {
  const d = e.target.dataset;
  if (d.plan) run(async () => {
    const plan = await api(`/api/schedules/${d.plan}/plan`);
    const rows = plan.map((p) => `
      <tr>
        <td>${esc(p.name || p.email)}<br><small class="muted">${esc(p.company)}</small></td>
        <td>${esc(p.matched.join(', ') || '—')}</td>
        <td>${p.skip ? `<span class="badge neutral">skip: ${esc(p.skip)}</span>` : '<span class="badge ok">will send</span>'}</td>
      </tr>`).join('');
    const sending = plan.filter((p) => !p.skip).length;
    openModal(`${sending} of ${plan.length} recruiters will be emailed`, `
      <table><thead><tr><th>Recruiter</th><th>Matched skills</th><th>Result</th></tr></thead><tbody>${rows}</tbody></table>`);
  });
  if (d.run) run(async () => {
    if (!confirm('Send emails for this schedule right now?')) return;
    await api(`/api/schedules/${d.run}/run`, { method: 'POST' });
    toast('Sending started — check the log below');
    await loadSchedules();
  });
  if (d.cancel) run(async () => {
    await api(`/api/schedules/${d.cancel}/cancel`, { method: 'POST' });
    await loadSchedules();
  });
  if (d.delete) run(async () => {
    if (!confirm('Delete this schedule?')) return;
    await api(`/api/schedules/${d.delete}`, { method: 'DELETE' });
    await loadSchedules();
  });
});

// ---------- logs ----------
async function loadLogs() {
  const logs = await api('/api/logs');
  const tbody = $('#logTable tbody');
  tbody.innerHTML = logs.map((l) => `
    <tr>
      <td>${fmtDate(l.at)}</td>
      <td>${esc(l.scheduleName)}</td>
      <td>${esc(l.recruiterName)}<br><small class="muted">${esc(l.recruiterEmail)}</small></td>
      <td>${esc(l.company)}</td>
      <td>${esc((l.matched || []).join(', '))}</td>
      <td><span class="badge ${l.status === 'sent' ? 'ok' : 'bad'}" title="${esc(l.error || '')}">${esc(l.status)}</span>${l.error ? `<br><small class="muted">${esc(l.error)}</small>` : ''}</td>
    </tr>`).join('');
  $('#logEmpty').classList.toggle('hidden', logs.length > 0);
}

$('#refreshLogs').onclick = () => run(async () => { await loadLogs(); await loadSchedules(); });
$('#clearLogs').onclick = () => run(async () => {
  if (!confirm('Clear the sent log? Recruiters will then be treated as not-yet-contacted.')) return;
  await api('/api/logs', { method: 'DELETE' });
  await loadLogs();
});

// ---------- init ----------
run(async () => {
  await loadStatus();
  await loadLevels();
  await loadProfile();
  await loadRecruiters();
  await loadTemplate();
  await loadSchedules();
  await loadLogs();
});

// Keep schedule status + log fresh while a send is in progress
setInterval(() => { loadSchedules().catch(() => {}); loadLogs().catch(() => {}); }, 15000);
