const test = require('node:test');
const assert = require('node:assert/strict');

let validatePayload;

test.before(async () => {
    ({ validatePayload } = await import('../scripts/validate-dispatch-refs.mjs'));
});

const ALLOWED = ['SynapsVault/backend', 'SynapsVault/frontend'];

test('accepts full SHAs and default refs', () => {
    const result = validatePayload(
        {
            backend_ref: 'a'.repeat(40),
            frontend_ref: 'refs/heads/main',
            backend_repository: 'SynapsVault/backend',
        },
        ALLOWED,
    );
    assert.equal(result.backend_ref, 'a'.repeat(40));
    assert.equal(result.frontend_ref, 'refs/heads/main');
});

test('defaults missing refs to refs/heads/main', () => {
    const result = validatePayload({}, ALLOWED);
    assert.equal(result.backend_ref, 'refs/heads/main');
    assert.equal(result.frontend_ref, 'refs/heads/main');
});

test('rejects malformed refs before checkout', () => {
    for (const bad of ['main', '../../etc/passwd', 'https://evil.example/x', 'refs/heads/a; rm -rf']) {
        assert.throws(
            () => validatePayload({ backend_ref: bad }, ALLOWED),
            (error) => error.details.some((d) => d.includes('backend_ref')),
            `expected '${bad}' to be rejected`,
        );
    }
});

test('rejects refs from unpermitted repositories', () => {
    assert.throws(
        () => validatePayload({ frontend_repository: 'evil/frontend' }, ALLOWED),
        (error) => error.details.some((d) => d.includes('not a permitted source repository')),
    );
});
