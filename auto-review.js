// auto-review.js — AI reviewer that runs after task completes
// Uses claude-haiku for fast, cheap code review

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

let _client = null;
function getClient() {
  if (!_client) {
    const Anthropic = require('@anthropic-ai/sdk');
    _client = new Anthropic(); // uses ANTHROPIC_API_KEY
  }
  return _client;
}

// Get git diff for a project path (last commit or staged changes)
function getGitDiff(projectPath) {
  if (!projectPath || !fs.existsSync(projectPath)) return { stat: '', full: '' };
  try {
    // Try uncommitted changes first, fall back to last commit
    let full = '';
    let stat = '';
    try {
      full = execSync('git diff HEAD --unified=3', { cwd: projectPath, timeout: 8000, stdio: ['pipe','pipe','pipe'] }).toString();
      stat = execSync('git diff HEAD --stat', { cwd: projectPath, timeout: 8000, stdio: ['pipe','pipe','pipe'] }).toString();
    } catch {}
    if (!full.trim()) {
      try {
        full = execSync('git diff HEAD~1 HEAD --unified=3', { cwd: projectPath, timeout: 8000, stdio: ['pipe','pipe','pipe'] }).toString();
        stat = execSync('git diff HEAD~1 HEAD --stat', { cwd: projectPath, timeout: 8000, stdio: ['pipe','pipe','pipe'] }).toString();
      } catch {}
    }
    if (full.length > 10000) full = full.slice(0, 10000) + '\n...(diff truncated)';
    return { stat: stat.trim(), full: full.trim() };
  } catch (e) {
    return { stat: '', full: '', error: e.message };
  }
}

// Run tests if test script exists, return result
function runTests(projectPath) {
  if (!projectPath || !fs.existsSync(projectPath)) return null;
  try {
    const pkgPath = path.join(projectPath, 'package.json');
    if (!fs.existsSync(pkgPath)) return null;
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const testScript = pkg.scripts?.test;
    if (!testScript || testScript.includes('no test specified') || testScript.includes('echo')) return null;

    console.log(`[AutoReview] Running tests in ${projectPath}...`);
    let output = '';
    try {
      output = execSync('npm test 2>&1', {
        cwd: projectPath,
        timeout: 90000,
        env: { ...process.env, CI: 'true', NODE_ENV: 'test', FORCE_COLOR: '0' },
        stdio: ['pipe', 'pipe', 'pipe'],
      }).toString();
    } catch (e) {
      output = (e.stdout?.toString() || '') + (e.stderr?.toString() || '') || e.message;
    }
    if (output.length > 4000) output = output.slice(-4000);
    const failed = /\b(FAIL|FAILED|Error:|failed|✗|✘|\d+ failing)\b/.test(output);
    return { output: output.trim(), passed: !failed };
  } catch (e) {
    return null;
  }
}

// Main review function
async function runAutoReview({ task, lastResponse }) {
  const projectPath = task.project_path || '';
  console.log(`[AutoReview] Starting review for task #${task.id}: "${task.title}"`);

  const diff = getGitDiff(projectPath);
  const tests = runTests(projectPath);

  // Build context
  const sections = [];
  sections.push(`## Task\n**Title:** ${task.title}\n**Description:** ${task.description || '(no description provided)'}`);

  if (diff.full) {
    sections.push(`## Git Changes (diff)\n\`\`\`diff\n${diff.full}\n\`\`\``);
  } else if (diff.stat) {
    sections.push(`## Git Changes\n${diff.stat}`);
  } else {
    sections.push(`## Git Changes\nNo git changes detected in: ${projectPath || 'HOME'}`);
  }

  if (tests) {
    const icon = tests.passed ? '✅' : '❌';
    sections.push(`## Test Results\n${icon} Tests ${tests.passed ? 'PASSED' : 'FAILED'}\n\`\`\`\n${tests.output}\n\`\`\``);
  }

  if (lastResponse) {
    sections.push(`## Agent Summary\n${lastResponse.slice(0, 2000)}`);
  }

  const prompt = `You are a code reviewer. Review this completed AI coding task.

${sections.join('\n\n')}

---
Review checklist:
1. Was the task description fulfilled?
2. Are the git changes correct and complete?
3. Are tests passing (if ran)?
4. Any obvious bugs, security issues, or incomplete work?

Respond with EXACTLY this format:
Line 1: APPROVED or CHANGES_REQUESTED
Line 2+: Brief explanation (2-4 sentences). If CHANGES_REQUESTED, list specific issues.

Be practical: APPROVE if the task is substantially complete. Minor style issues → APPROVED.
Missing core functionality, failing tests, or broken code → CHANGES_REQUESTED.`;

  const response = await getClient().messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 512,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = response.content[0].text.trim();
  const firstLine = text.split('\n')[0].trim().toUpperCase();
  const approved = firstLine === 'APPROVED' || (firstLine.includes('APPROVED') && !firstLine.includes('CHANGES'));

  console.log(`[AutoReview] Task #${task.id}: ${approved ? 'APPROVED' : 'CHANGES_REQUESTED'}`);

  return {
    status: approved ? 'approved' : 'changes_requested',
    notes: text,
    hasDiff: !!diff.full,
    testsPassed: tests?.passed,
  };
}

module.exports = { runAutoReview };
