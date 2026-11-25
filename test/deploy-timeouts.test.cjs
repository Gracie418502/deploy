const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repo = path.resolve(__dirname, '..');
const checker = path.join(repo, 'scripts/check-deploy-timeouts.mjs');
const workflow = fs.readFileSync(
    path.join(repo, '.github/workflows/deploy-k8s.yml'),
    'utf8',
);

test('every deploy step and the job itself are bounded', () => {
    const result = spawnSync('node', [checker, '.github/workflows/deploy-k8s.yml'], {
        cwd: repo,
        encoding: 'utf8',
    });
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /bounded timeouts/);
});

test('a workflow with an unbounded step is rejected', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-timeout-'));
    const file = path.join(dir, 'deploy-k8s.yml');
    // Remove one step timeout to simulate a stalled step that could run forever.
    fs.writeFileSync(file, workflow.replace(/^        timeout-minutes: 10$/gm, ''));
    const result = spawnSync('node', [checker, file], { cwd: repo, encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /step missing timeout-minutes/);
});

test('a workflow without a job ceiling is rejected', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-timeout-'));
    const file = path.join(dir, 'deploy-k8s.yml');
    fs.writeFileSync(file, workflow.replace('    timeout-minutes: 30\n', ''));
    const result = spawnSync('node', [checker, file], { cwd: repo, encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /deploy job has no timeout-minutes/);
});
