// Tiny JSON-file persistence layer. Everything lives under ./data
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');

function filePath(name) {
  return path.join(DATA_DIR, `${name}.json`);
}

function read(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath(name), 'utf8'));
  } catch {
    return fallback;
  }
}

function write(name, value) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(filePath(name), JSON.stringify(value, null, 2));
}

function nextId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

module.exports = { read, write, nextId, DATA_DIR };
