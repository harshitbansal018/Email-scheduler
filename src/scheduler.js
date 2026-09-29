// Registers schedules with node-schedule and runs the send job when they fire.
// Schedules are persisted in data/schedules.json so they survive restarts.
const schedule = require('node-schedule');
const path = require('path');
const store = require('./store');
const resume = require('./resume');
const { matchRecruiter, buildEmail } = require('./matcher');
const { sendMail } = require('./mailer');

const jobs = new Map(); // scheduleId -> node-schedule Job
const running = new Set(); // scheduleIds currently sending

const DELAY_BETWEEN_MAILS_MS = 3000; // gentle pacing so Gmail doesn't flag bursts

function getSchedules() {
  return store.read('schedules', []);
}

function saveSchedules(list) {
  store.write('schedules', list);
}

function updateSchedule(id, patch) {
  const list = getSchedules();
  const idx = list.findIndex((s) => s.id === id);
  if (idx === -1) return null;
  list[idx] = { ...list[idx], ...patch };
  saveSchedules(list);
  return list[idx];
}

function appendLog(entry) {
  const logs = store.read('logs', []);
  logs.unshift({ id: store.nextId(), at: new Date().toISOString(), ...entry });
  store.write('logs', logs.slice(0, 1000));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Recruiters who already got a successful email (from any schedule)
function contactedRecruiterIds() {
  const logs = store.read('logs', []);
  return new Set(logs.filter((l) => l.status === 'sent').map((l) => l.recruiterId));
}

// Decide which recruiters this schedule would email right now (used for preview + run)
function planRecipients(sched) {
  const profile = resume.getProfile();
  const recruiters = store.read('recruiters', []);
  const contacted = sched.skipContacted === false ? new Set() : contactedRecruiterIds();
  const onlyIds = sched.recruiterIds && sched.recruiterIds.length ? new Set(sched.recruiterIds) : null;

  const plan = [];
  for (const r of recruiters) {
    if (onlyIds && !onlyIds.has(r.id)) continue;
    const { matched, score } = matchRecruiter(r, profile.skills || []);
    let skip = null;
    if (contacted.has(r.id)) skip = 'already contacted';
    else if (score < (sched.minMatch || 0)) skip = `only ${score} matching skill(s), need ${sched.minMatch}`;
    plan.push({ recruiter: r, matched, score, skip });
  }
  const limit = sched.maxPerRun || 100;
  let count = 0;
  for (const p of plan) {
    if (p.skip) continue;
    if (count >= limit) p.skip = `over max ${limit} per run`;
    else count++;
  }
  return { plan, profile };
}

async function runSchedule(id, { manual = false } = {}) {
  const sched = getSchedules().find((s) => s.id === id);
  if (!sched) return { error: 'schedule not found' };
  if (running.has(id)) return { error: 'already running' };
  running.add(id);

  const summary = { sent: 0, failed: 0, skipped: 0 };
  try {
    const { plan, profile } = planRecipients(sched);
    const resumePath = resume.getResumePath();
    const attachmentName = profile.resumeOriginalName || (resumePath ? path.basename(resumePath) : undefined);

    for (const item of plan) {
      const r = item.recruiter;
      if (item.skip) {
        summary.skipped++;
        continue;
      }
      const email = buildEmail(r, profile, item.matched);
      try {
        await sendMail({
          to: r.email,
          subject: email.subject,
          text: email.text,
          attachmentPath: resumePath,
          attachmentName,
        });
        summary.sent++;
        appendLog({
          scheduleId: sched.id, scheduleName: sched.name, recruiterId: r.id,
          recruiterName: r.name, recruiterEmail: r.email, company: r.company,
          subject: email.subject, matched: item.matched, status: 'sent',
        });
      } catch (err) {
        summary.failed++;
        appendLog({
          scheduleId: sched.id, scheduleName: sched.name, recruiterId: r.id,
          recruiterName: r.name, recruiterEmail: r.email, company: r.company,
          subject: email.subject, matched: item.matched, status: 'failed', error: err.message,
        });
      }
      await sleep(DELAY_BETWEEN_MAILS_MS);
    }
  } finally {
    running.delete(id);
  }

  const patch = {
    lastRunAt: new Date().toISOString(),
    runs: (sched.runs || 0) + 1,
    sentTotal: (sched.sentTotal || 0) + summary.sent,
    lastSummary: summary,
  };
  if (sched.repeat === 'once' && !manual) patch.status = 'done';
  updateSchedule(id, patch);
  console.log(`[scheduler] "${sched.name}" ran: ${JSON.stringify(summary)}`);
  return summary;
}

function unregister(id) {
  const job = jobs.get(id);
  if (job) job.cancel();
  jobs.delete(id);
}

// Hook a schedule into node-schedule. Returns the next fire time or null.
function register(sched) {
  unregister(sched.id);
  if (sched.status !== 'pending') return null;

  const runAt = new Date(sched.runAt);
  if (Number.isNaN(runAt.getTime())) return null;
  const fire = () => runSchedule(sched.id).catch((e) => console.error('[scheduler] run failed', e));

  let job;
  if (sched.repeat === 'once') {
    if (runAt.getTime() <= Date.now()) {
      updateSchedule(sched.id, { status: 'missed' });
      return null;
    }
    job = schedule.scheduleJob(runAt, fire);
  } else {
    const rule = new schedule.RecurrenceRule();
    rule.hour = runAt.getHours();
    rule.minute = runAt.getMinutes();
    if (sched.repeat === 'weekly') rule.dayOfWeek = runAt.getDay();
    // Don't fire before the chosen start date/time (start is exclusive, so step back 1s
    // so the very first run can happen exactly at the chosen time)
    job = schedule.scheduleJob({ start: new Date(runAt.getTime() - 1000), rule }, fire);
  }
  if (job) jobs.set(sched.id, job);
  return job ? job.nextInvocation() : null;
}

function nextRun(id) {
  const job = jobs.get(id);
  const next = job && job.nextInvocation();
  return next ? new Date(next).toISOString() : null;
}

function createSchedule(input) {
  const sched = {
    id: store.nextId(),
    name: input.name || 'Untitled schedule',
    runAt: input.runAt,
    repeat: ['once', 'daily', 'weekly'].includes(input.repeat) ? input.repeat : 'once',
    minMatch: Math.max(0, parseInt(input.minMatch, 10) || 0),
    maxPerRun: Math.max(1, parseInt(input.maxPerRun, 10) || 100),
    skipContacted: input.skipContacted !== false,
    recruiterIds: Array.isArray(input.recruiterIds) ? input.recruiterIds : [],
    status: 'pending',
    createdAt: new Date().toISOString(),
    runs: 0,
    sentTotal: 0,
  };
  const list = getSchedules();
  list.unshift(sched);
  saveSchedules(list);
  register(sched);
  return sched;
}

function cancelSchedule(id) {
  unregister(id);
  return updateSchedule(id, { status: 'cancelled' });
}

function deleteSchedule(id) {
  unregister(id);
  saveSchedules(getSchedules().filter((s) => s.id !== id));
}

// Called once at server start
function init() {
  let count = 0;
  for (const sched of getSchedules()) {
    if (register(sched)) count++;
  }
  console.log(`[scheduler] ${count} pending schedule(s) registered`);
}

module.exports = {
  init, getSchedules, createSchedule, cancelSchedule, deleteSchedule,
  runSchedule, planRecipients, nextRun, isRunning: (id) => running.has(id),
};
