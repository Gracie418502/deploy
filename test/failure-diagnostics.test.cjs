const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repo = path.resolve(__dirname, '..');
const sanitizer = path.join(repo, 'scripts/sanitize-diagnostics.mjs');

function sanitize(input) {
    return spawnSync('node', [sanitizer], { input, encoding: 'utf8' }).stdout;
}

test('drops Secret objects and redacts env values', () => {
    const input = [
        'apiVersion: v1',
        'kind: Secret',
        'data:',
        '  password: c3VwZXJzZWNyZXQ=',
        '---',
        'kind: Pod',
        'name: backend-1',
        'env:',
        '  - name: DB_PASSWORD',
        '    value: hunter2',
        '  - name: LOG_LEVEL',
        '    value: info',
        'DSN=postgres://user:pass@db:5432/app',
        'IMAGE=ghcr.io/synapsvault/backend:sha-abc',
    ].join('\n');
    const output = sanitize(input);
    assert.doesNotMatch(output, /kind: Secret/);
    assert.doesNotMatch(output, /c3VwZXJzZWNyZXQ/);
    assert.doesNotMatch(output, /hunter2/);
    assert.doesNotMatch(output, /user:pass@db/);
    assert.match(output, /name: backend-1/);
    assert.match(output, /LOG_LEVEL/);
    assert.match(output, /info/);
});

test('collector captures pod status, events and migration job state safely', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diag-'));
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(
        path.join(bin, 'kubectl'),
        [
            '#!/usr/bin/env bash',
            'case "$*" in',
            '  *"get pods -o wide"*) echo "backend-1 Running";;',
            '  *"get pods -o yaml"*) printf "kind: Secret\\ndata:\\n  token: abc\\n---\\nkind: Pod\\nname: backend-1\\n";;',
            '  *"get events"*) echo "Pulled image backend";;',
            '  *"get job backend-migrate"*) echo "backend-migrate Complete";;',
            '  *"get deployments"*) echo "backend 1/1";;',
            'esac',
        ].join('\n') + '\n',
    );
    fs.chmodSync(path.join(bin, 'kubectl'), 0o755);

    const out = path.join(dir, 'out');
    const result = spawnSync('bash', [path.join(repo, 'scripts/collect-diagnostics.sh'), 'synapsvault-production', out], {
        cwd: repo,
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
        encoding: 'utf8',
    });
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    for (const name of ['pods', 'pod_yaml', 'events', 'migration_job', 'deployments', 'summary']) {
        assert.ok(fs.existsSync(path.join(out, `${name}.txt`)), `missing ${name}.txt`);
    }
    const podYaml = fs.readFileSync(path.join(out, 'pod_yaml.txt'), 'utf8');
    assert.doesNotMatch(podYaml, /kind: Secret/);
    assert.doesNotMatch(podYaml, /abc/);
    assert.match(podYaml, /name: backend-1/);
    assert.match(fs.readFileSync(path.join(out, 'summary.txt'), 'utf8'), /synapsvault-production/);
});
