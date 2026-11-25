#!/usr/bin/env node
/**
 * Validate repository_dispatch application refs before any checkout/build (#155).
 *
 * Inputs (environment):
 *   DISPATCH_PAYLOAD   - JSON string of github.event.client_payload
 *   ALLOWED_REPOSITORIES - comma-separated allowed source repositories
 *
 * Outputs (stdout, one KEY=VALUE per line, suitable for $GITHUB_OUTPUT):
 *   backend_ref=... / frontend_ref=... / accepted_refs=...
 */

const REF_PATTERN = /^(?:[0-9a-f]{40}|refs\/(?:heads|tags)\/[A-Za-z0-9._/-]+)$/;

export function validatePayload(payload, allowedRepositories) {
    const errors = [];
    const result = {};

    for (const app of ['backend', 'frontend']) {
        const refKey = `${app}_ref`;
        const repoKey = `${app}_repository`;
        const rawRef = payload?.[refKey];
        const ref = rawRef === undefined || rawRef === null || rawRef === ''
            ? 'refs/heads/main'
            : String(rawRef);

        if (!REF_PATTERN.test(ref)) {
            errors.push(`${refKey} '${ref}' is not a full SHA or refs/heads|refs/tags ref`);
        }

        if (payload?.[repoKey] !== undefined && payload?.[repoKey] !== null) {
            const repository = String(payload[repoKey]);
            if (!allowedRepositories.includes(repository)) {
                errors.push(`${repoKey} '${repository}' is not a permitted source repository`);
            }
        }
        result[refKey] = ref;
    }

    if (errors.length > 0) {
        const error = new Error('Invalid repository_dispatch payload');
        error.details = errors;
        throw error;
    }
    return result;
}

function main() {
    const payload = JSON.parse(process.env.DISPATCH_PAYLOAD ?? '{}');
    const allowed = (process.env.ALLOWED_REPOSITORIES ?? '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);

    if (allowed.length === 0) {
        console.error('ALLOWED_REPOSITORIES must list the permitted source repositories');
        process.exit(1);
    }

    let refs;
    try {
        refs = validatePayload(payload, allowed);
    } catch (error) {
        for (const detail of error.details ?? [error.message]) {
            console.error(`::error::${detail}`);
        }
        process.exit(1);
    }

    console.log(`backend_ref=${refs.backend_ref}`);
    console.log(`frontend_ref=${refs.frontend_ref}`);
    console.log(
        `accepted_refs=${JSON.stringify({
            backend: refs.backend_ref,
            frontend: refs.frontend_ref,
        })}`,
    );
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
    main();
}
