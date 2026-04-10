// auto-review.js — AI reviewer using Claude Code CLI (claude -p)
// Spawns a separate claude process to review task completion

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// Run Claude Code in print mode with given prompt in a directory
// Returns stdout text or throws on timeout/error
function runClaudePrint(prompt, cwd, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const args = ['-p', prompt, '--dangerously-skip-permissions'];
    const proc = spawn('claude', args, {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      reject(new Error(`Reviewer timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);

    proc.on('close', code => {
      clearTimeout(timer);
      if (code !== 0 && !stdout.trim()) {
        reject(new Error(`claude exited ${code}: ${stderr.slice(0, 300)}`));
      } else {
        resolve(stdout.trim());
      }
    });

    proc.on('error', err => {
      clearTimeout(timer);
      reject(new Error(`Failed to spawn claude: ${err.message}`));
    });
  });
}

// Main review function — called after task moves to review column
async function runAutoReview({ task, lastResponse }) {
  const projectPath = task.project_path || process.env.HOME;
  console.log(`[AutoReview] Starting review for task #${task.id}: "${task.title}"`);

  const prompt = `You are a code reviewer. A coding task has just been completed by an AI agent. Your job is to verify the work.

TASK TITLE: ${task.title}
TASK DESCRIPTION: ${task.description || '(no description)'}

Steps to review (use your tools freely):
1. Run \`git diff HEAD~1 HEAD\` (or \`git diff HEAD\`) to see what changed
2. Check if the changes match the task description — were all requirements fulfilled?
3. If there's a package.json with a real test script, run \`npm test\`
4. Look for obvious bugs, broken logic, or missing pieces

DO NOT make any changes to the code. Read-only analysis only.

${lastResponse ? `AGENT SUMMARY (what the agent reported):\n${lastResponse.slice(0, 1500)}\n` : ''}

Respond with EXACTLY this format:
Line 1: APPROVED or CHANGES_REQUESTED
Line 2+: Explanation (2-5 sentences). If CHANGES_REQUESTED, list the specific issues that must be fixed.

Be practical: APPROVE if the task is substantially complete. Minor style issues → APPROVED. Missing core functionality, failing tests, or clearly broken code → CHANGES_REQUESTED.`;

  const text = await runClaudePrint(prompt, projectPath);

  // Parse result — look for APPROVED/CHANGES_REQUESTED anywhere in first line
  const firstLine = text.split('\n')[0].trim().toUpperCase();
  const approved = firstLine.startsWith('APPROVED') && !firstLine.includes('CHANGES');

  console.log(`[AutoReview] Task #${task.id}: ${approved ? 'APPROVED' : 'CHANGES_REQUESTED'}`);

  return {
    status: approved ? 'approved' : 'changes_requested',
    notes: text,
  };
}

module.exports = { runAutoReview };
