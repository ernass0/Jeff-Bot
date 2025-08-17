// src/runner.js
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import fetch from 'node-fetch';

const HF_TOKEN = process.env.HF_API_TOKEN;
const MODEL_ID = process.env.MODEL_ID || 'HuggingFaceH4/starchat2-15b-v0.1';
if (!HF_TOKEN) {
  console.error('Missing HF_API_TOKEN in env. Stop.');
  process.exit(1);
}

const COMMAND_FILE = 'AI_COMMANDS.md';
const AUDIT_FILE = 'AI_REPORT.md';

// --- helper: read commands
function readCommands() {
  if (!fs.existsSync(COMMAND_FILE)) {
    return '';
  }
  return fs.readFileSync(COMMAND_FILE, 'utf8');
}

// --- helper: extract JSON object from model text
function extractFirstJson(text) {
  // attempt to find {...} block
  const jsonMatch = text.match(/\{[\s\S]*\}/m);
  if (!jsonMatch) return null;
  try {
    return JSON.parse(jsonMatch[0]);
  } catch (e) {
    // try to fix simple trailing commas
    const cleaned = jsonMatch[0].replace(/,\s*}/g, '}').replace(/,\s*]/g, ']');
    try {
      return JSON.parse(cleaned);
    } catch (e2) {
      console.error('Failed to parse JSON from model response', e2.message);
      return null;
    }
  }
}

// --- call Hugging Face Inference API (text generation)
async function callModel(prompt) {
  const url = `https://api-inference.huggingface.co/models/${MODEL_ID}`;
  const body = {
    inputs: prompt,
    parameters: {
      max_new_tokens: 1024,
      do_sample: false
    }
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${HF_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HF API error ${res.status}: ${text}`);
  }
  const data = await res.json();
  // Many HF models return array with generated_text or a text key
  // handle common variations:
  if (Array.isArray(data) && data[0]) {
    if (data[0].generated_text) return data[0].generated_text;
    if (data[0].generated_text === undefined && typeof data[0] === 'string') return data[0];
  }
  if (data.generated_text) return data.generated_text;
  if (typeof data === 'string') return data;
  // fallback: stringify
  return JSON.stringify(data);
}

// --- apply actions safely
function applyActions(actions) {
  const performed = [];
  // whitelist base dir to avoid accidental root changes
  const SAFE_BASE = path.join(process.cwd(), 'ai-workspace');
  if (!fs.existsSync(SAFE_BASE)) {
    fs.mkdirSync(SAFE_BASE, { recursive: true });
  }

  // allow create/update only inside ai-workspace or specific files
  for (const act of actions) {
    const { type, path: filePath, content } = act;
    const absolute = path.resolve(filePath);
    // allow special-case modifying README.md or AI_REPORT.md at repo root if explicitly allowed
    const allowedRootFiles = ['README.md', 'AI_REPORT.md', 'AI_COMMANDS.md'];
    const isSafe = absolute.startsWith(SAFE_BASE) || allowedRootFiles.includes(filePath);
    if (!isSafe) {
      performed.push({ status: 'skipped', reason: 'not in safe path', action: act });
      continue;
    }

    try {
      if (type === 'create' || type === 'update') {
        const dir = path.dirname(absolute);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(absolute, content || '', 'utf8');
        performed.push({ status: 'ok', action: act });
      } else if (type === 'delete') {
        if (fs.existsSync(absolute)) {
          fs.unlinkSync(absolute);
          performed.push({ status: 'ok', action: act });
        } else {
          performed.push({ status: 'missing', action: act });
        }
      } else {
        performed.push({ status: 'unknown_action', action: act });
      }
    } catch (e) {
      performed.push({ status: 'error', error: e.message, action: act });
    }
  }
  return performed;
}

function appendAudit(performed, rawModelResponse) {
  const now = new Date().toISOString();
  let out = `## AI run at ${now}\n\n`;
  for (const p of performed) {
    out += `- ${p.status}: ${JSON.stringify(p.action)}${p.error ? ' error: ' + p.error : ''}\n`;
  }
  out += `\nModel raw response:\n\`\`\`\n${rawModelResponse}\n\`\`\`\n\n----\n`;
  fs.appendFileSync(AUDIT_FILE, out, 'utf8');
}

// commit & push changes
function gitCommitAndPush(message = 'AI automated changes') {
  try {
    execSync('git config user.name "github-actions[bot]"');
    execSync('git config user.email "actions@github.com"');
    execSync('git add -A');
    execSync(`git commit -m "${message}" || echo "no changes to commit"`);
    // push: actions/checkout configured remote; GITHUB_TOKEN used by action environment
    execSync('git push origin HEAD');
    console.log('Changes pushed');
  } catch (e) {
    console.error('git push error (maybe no changes or auth issue):', e.message);
  }
}

async function main() {
  const commandsText = readCommands();
  if (!commandsText.trim()) {
    console.log('No commands found in AI_COMMANDS.md');
    return;
  }

  // Build prompt: ask the model to output **only JSON array** of actions.
  const prompt = `
You are an autonomous repository assistant. I will give you raw instructions from AI_COMMANDS.md. Output ONLY a JSON array (no extra prose). Each array item must be an object with:
- "type": one of "create", "update", "delete"
- "path": path to the file (relative to repo root)
- "content": (only for create/update) string content of the file

If you refuse or cannot perform something, mark it as {"type":"skip","path":"...","reason":"..."}.

Here are the commands:
-----
${commandsText}
-----

Rules:
- Only return JSON array. Example:
[
  {"type":"create","path":"ai-workspace/hello.txt","content":"Hello"},
  {"type":"delete","path":"ai-workspace/old.txt"}
]

- Do NOT return anything else outside the JSON.

Now produce the JSON array.
`;

  console.log('Calling model...');
  let modelText;
  try {
    modelText = await callModel(prompt);
  } catch (e) {
    console.error('Model call failed:', e.message);
    process.exit(1);
  }
  console.log('Model replied (snippet):', modelText.slice(0, 500));

  const js = extractFirstJson(modelText);
  if (!js) {
    console.error('No JSON detected from model. Saving raw output to audit and exiting.');
    appendAudit([{ status: 'model_no_json', action: null }], modelText);
    process.exit(1);
  }

  if (!Array.isArray(js)) {
    console.error('Model JSON is not an array. Saving and exiting.');
    appendAudit([{ status: 'model_invalid_format', action: js }], modelText);
    process.exit(1);
  }

  const result = applyActions(js);
  appendAudit(result, modelText);
  gitCommitAndPush('Automated changes by AI runner');
}

main().catch(err => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
