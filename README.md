# Recruiter Email Scheduler

Finds jobs worldwide, matches them against your resume, looks up the recruiter's email, and sends a personalized application on a schedule — with your resume attached.

Runs locally on your own machine. Your resume, contacts and credentials never leave it except as the emails you send.

- **Resume parsing** — detects your skills from a PDF
- **Global job search** — Remotive, Himalayas, Arbeitnow, Greenhouse/Lever boards, Adzuna (India)
- **Skill matching** — reads each job description and scores it against your skills
- **Location & experience filters** — India + remote presets, years-of-experience and seniority filtering, plus an "only jobs that hire from my country" check
- **Recruiter lookup** — finds HR contacts via Hunter.io
- **Scheduled sending** — once / daily / weekly, with per-run caps and duplicate protection

## What is NOT in this repo

`.gitignore` keeps your private data out of git. Never commit these:

| Path | Contains |
|---|---|
| `.env` | Gmail App Password, Hunter & Adzuna API keys |
| `uploads/` | Your resume |
| `data/*.json` | Your recruiters, schedules, sent log, parsed profile |

Only `data/skills.json` (the shared skill dictionary) is tracked. If you fork this, double-check with `git status` before your first commit.

## Setup

1. Install dependencies (Node.js 18+):

   ```
   npm install
   ```

2. Create a Gmail **App Password** (your normal password will not work):
   - Turn on 2-Step Verification: https://myaccount.google.com/security
   - Create an app password: https://myaccount.google.com/apppasswords
   - Copy the 16-character password

3. Copy `.env.example` to `.env` and fill in:

   ```
   GMAIL_USER=yourname@gmail.com
   GMAIL_APP_PASSWORD=xxxxxxxxxxxxxxxx
   MY_NAME=Your Name
   MY_PHONE=+91 00000 00000
   MY_LINKEDIN=https://linkedin.com/in/yourprofile
   ```

4. Start the app:

   ```
   npm start
   ```

   Open http://localhost:3000

> The app must be running for scheduled emails to go out. Keep the terminal open (or run it with `pm2` / as a service).

### Optional: Hunter.io key (for finding recruiter emails automatically)

Job discovery works without this. You only need a key for the *"Find recruiter emails"* step.

1. Sign up free at https://hunter.io (no card needed — 50 credits/month)
2. Copy your key from https://hunter.io/api-keys
3. Add it to `.env`:
   ```
   HUNTER_API_KEY=your_key_here
   ```
4. Restart the app

**Credits:** one credit = one email found. The app makes **one lookup per company**, not per job — so 10 jobs at 3 companies costs ~3 lookups. The credit counter is shown in the UI next to the button.

## How it works

1. **Resume & Skills** — upload your resume (PDF or TXT). Skills are detected using the dictionary in `data/skills.json`. Edit the detected list if needed.

2. **Find jobs & recruiters globally** — searches public job boards, reads each job description, detects the skills it requires and the experience it wants, and ranks jobs by how many skills match your resume.

   **Filters**
   - **Location** — defaults to `india, remote`. `india` is a preset matching every major Indian city and state (Bangalore, Bengaluru, NCR, Gurugram, Hyderabad, Maharashtra, APAC…), `remote` matches remote roles. Comma means OR. You can also type any city or country.
   - **Only remote jobs that hire from India** *(on by default)* — many remote jobs only hire in specific countries. This drops ones restricted to e.g. "USA, Canada only" and keeps ones listing India, APAC, or Anywhere. Untick it to see all remote jobs regardless.
   - **Your experience (years)** — hides jobs asking for clearly more than you have (1 year of slack, since postings overstate).
   - **Experience level** — pick one or more of Internship / Entry / Junior / Mid / Senior / Lead. Leave unselected for any.

   Experience is read from the job itself: an explicit figure in the description ("3+ years") is preferred, then the listing's own seniority field, then keywords in the title. The table shows which, on hover.

   Sources (all free, no key):
   - **Remotive** — global remote jobs, states which countries it hires from
   - **Himalayas** — global remote jobs, states seniority and country restrictions
   - **Arbeitnow** — global job board feed (Europe-heavy)
   - **Greenhouse / Lever** — any company's public board; enter slugs like `stripe, spotify` in the *companies* field

   > **For India-based (on-site / hybrid) jobs, add free Adzuna keys.** The sources above are remote-focused, so an `india`-only search returns few on-site roles. Sign up free (no card) at https://developer.adzuna.com/signup and put the two values in `.env`:
   > ```
   > ADZUNA_APP_ID=your_id
   > ADZUNA_APP_KEY=your_key
   > ```
   > Adzuna is then queried for India automatically whenever your location includes India.

   Then tick the jobs you want and click **Find recruiter emails for selected**. This uses Hunter to pull HR/recruiter contacts at those companies and adds them to your recruiter list, with the job's title and required skills already filled in.

   > Only this last step spends credits. Searching and matching are free and unlimited.

3. **Recruiters** — discovered recruiters land here automatically. You can also add them manually, or bulk-paste lines like:
   ```
   Priya Sharma | priya@acme.com | Acme Corp | Frontend Developer | React, JavaScript, CSS
   ```
   The **Match** column shows how many of their required skills you have.
4. **Email template** — customise subject/body. Placeholders like `{{matchedSkills}}` are filled per recruiter. Use *Send test email to me* to check the setup.
5. **Schedules** — pick a date/time, choose once / daily / weekly, and set:
   - **Min matching skills** — only email recruiters with at least this many matches
   - **Max emails per run** — Gmail allows ~500/day on a free account; keep this modest
   - **Skip recruiters already emailed** — never emails the same person twice (across all schedules)
   - **Recruiters** — leave empty for everyone, or pick specific ones

   *Who gets it?* previews exactly who will receive an email. *Run now* sends immediately.
6. **Sent log** — every email sent/failed, with the matched skills.

Schedules are saved in `data/schedules.json` and re-registered when the app restarts. A one-time schedule whose time passed while the app was off is marked **missed** (it won't send late) — use *Run now* if you still want it sent.

## Adding skills to the dictionary

Edit `data/skills.json` and add entries like:

```json
{ "name": "Spring Boot", "aliases": ["spring", "springboot"] }
```

Aliases let a recruiter's `nodejs` match your `Node.js`.

## Project layout

```
server.js          Express API + static UI
src/discovery.js   global job search + Hunter.io recruiter lookup
src/scheduler.js   node-schedule jobs, send loop, persistence
src/matcher.js     skill matching + template rendering
src/resume.js      resume parsing + skill detection
src/mailer.js      Gmail SMTP via nodemailer
src/store.js       JSON file storage (data/*.json)
public/            Web UI
data/skills.json   Skill dictionary
```
