const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repo = path.resolve(__dirname, '..');
const script = path.join(repo, 'scripts/verify-image-signatures.sh');

function withFakeTools({ images, cosignExit = 0 }, env = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-img-'));
    fs.writeFileSync(
        path.join(dir, 'kubectl'),
        `#!/usr/bin/env bash\nprintf '%s\\n' ${JSON.stringify(images.join('\n'))}\n`,
    );
    fs.writeFileSync(
        path.join(dir, 'yq'),
        "#!/usr/bin/env bash\ncat | grep -E 'image:' | sed -E 's/.*image: *//' | sort -u\n",
    );
    fs.writeFileSync(
        path.join(dir, 'cosign'),
        `#!/usr/bin/env bash\necho "$@" >> "${dir}/cosign-calls.log"\nexit ${cosignExit}\n`,
    );
    for (const name of ['kubectl', 'yq', 'cosign']) {
        fs.chmodSync(path.join(dir, name), 0o755);
    }

    const result = spawnSync('bash', [script, 'overlays/production'], {
        cwd: repo,
        env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, ...env },
        encoding: 'utf8',
    });
    return {
        status: result.status,
        output: `${result.stdout}${result.stderr}`,
        calls: fs.existsSync(path.join(dir, 'cosign-calls.log'))
            ? fs.readFileSync(path.join(dir, 'cosign-calls.log'), 'utf8')
            : '',
    };
}

const env = {
    COSIGN_IDENTITY: 'https://github.com/SynapsVault/backend/.github/workflows/build.yml@refs/heads/main',
    COSIGN_OIDC_ISSUER: 'https://token.actions.githubusercontent.com',
};

test('fails when identity or issuer is missing', () => {
    const result = withFakeTools({ images: ['ghcr.io/x/y@sha256:' + 'a'.repeat(64)] }, {
        COSIGN_IDENTITY: '',
        COSIGN_OIDC_ISSUER: '',
    });
    assert.equal(result.status, 1);
    assert.match(result.output, /COSIGN_IDENTITY and COSIGN_OIDC_ISSUER/);
});

test('rejects unpinned image tags before apply', () => {
    const result = withFakeTools({ images: ['image: taskapp-backend:latest'] }, env);
    assert.equal(result.status, 1);
    assert.match(result.output, /not pinned by sha256 digest/);
    assert.equal(result.calls, '');
});

test('verifies pinned images with the expected identity and issuer', () => {
    const digest = 'ghcr.io/synapsvault/backend@sha256:' + 'b'.repeat(64);
    const result = withFakeTools({ images: [`image: ${digest}`] }, env);
    assert.equal(result.status, 0, result.output);
    assert.match(result.calls, /--certificate-identity/);
    assert.match(result.calls, /--certificate-oidc-issuer/);
    assert.match(result.calls, new RegExp(digest.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('stops deploy when cosign rejects an image', () => {
    const digest = 'ghcr.io/synapsvault/frontend@sha256:' + 'c'.repeat(64);
    const result = withFakeTools({ images: [`image: ${digest}`], cosignExit: 1 }, env);
    assert.equal(result.status, 1);
});
