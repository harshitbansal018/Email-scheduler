// Reads the uploaded resume (PDF or TXT) and detects skills using data/skills.json
const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse/lib/pdf-parse.js');
const store = require('./store');

const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function extractText(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.pdf') {
    const data = await pdfParse(fs.readFileSync(filePath));
    return data.text || '';
  }
  return fs.readFileSync(filePath, 'utf8');
}

function loadDictionary() {
  const dict = store.read('skills', { skills: [] });
  return dict.skills || [];
}

// Returns the list of dictionary skills whose name or alias appears in the text
function detectSkills(text) {
  const lower = text.toLowerCase().replace(/\s+/g, ' ');
  const found = [];
  for (const skill of loadDictionary()) {
    const terms = [skill.name, ...(skill.aliases || [])];
    const hit = terms.some((term) => {
      // Word-boundary match; allow symbols like C++ / C# / .NET at the edges
      const re = new RegExp(`(^|[^a-z0-9])${escapeRegex(term.toLowerCase())}($|[^a-z0-9+#])`, 'i');
      return re.test(lower);
    });
    if (hit) found.push(skill.name);
  }
  return found;
}

// Save uploaded resume as the "current" one, parse it and remember detected skills
async function setResume(originalName, buffer) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  const ext = path.extname(originalName).toLowerCase() || '.pdf';
  const savedPath = path.join(UPLOAD_DIR, `resume${ext}`);
  // Remove any previously uploaded resume with a different extension
  for (const f of fs.readdirSync(UPLOAD_DIR)) {
    if (f.startsWith('resume') && f !== `resume${ext}`) fs.unlinkSync(path.join(UPLOAD_DIR, f));
  }
  fs.writeFileSync(savedPath, buffer);

  const text = await extractText(savedPath);
  const skills = detectSkills(text);

  const profile = store.read('profile', {});
  profile.resumeFile = path.basename(savedPath);
  profile.resumeOriginalName = originalName;
  profile.uploadedAt = new Date().toISOString();
  profile.detectedSkills = skills;
  // Keep user's manual edits only if they had any; otherwise use detected
  if (!profile.skills || profile.skills.length === 0) profile.skills = skills;
  store.write('profile', profile);
  return profile;
}

function getProfile() {
  return store.read('profile', { skills: [], detectedSkills: [] });
}

function getResumePath() {
  const profile = getProfile();
  if (!profile.resumeFile) return null;
  const p = path.join(UPLOAD_DIR, profile.resumeFile);
  return fs.existsSync(p) ? p : null;
}

module.exports = { setResume, getProfile, getResumePath, detectSkills };
