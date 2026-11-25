#!/usr/bin/env node
/**
 * Verify the deploy workflow has bounded job and step durations (#158).
 * Usage: node scripts/check-deploy-timeouts.mjs [path/to/deploy-k8s.yml]
 */
import { readFileSync } from 'node:fs';

const file = process.argv[2] ?? '.github/workflows/deploy-k8s.yml';
const lines = readFileSync(file, 'utf8').split(/\r?\n/);
const errors = [];

const jobStart = lines.findIndex((line) => /^  deploy:\s*$/.test(line));
if (jobStart === -1) {
    errors.push('missing deploy job');
} else {
    const jobEnd = lines.findIndex(
        (line, index) => index > jobStart && /^  [a-zA-Z]/.test(line),
    );
    const jobLines = lines.slice(jobStart, jobEnd === -1 ? undefined : jobEnd);
    const jobTimeout = jobLines.find((line) => /^    timeout-minutes:\s*\d+/.test(line));
    if (!jobTimeout) {
        errors.push('deploy job has no timeout-minutes');
    } else {
        const minutes = Number(jobTimeout.split(':')[1].trim());
        if (minutes < 1 || minutes > 60) errors.push(`job timeout ${minutes} is outside 1..60 minutes`);
    }

    let steps = 0;
    for (const line of jobLines) {
        if (/^      - (?:name|uses):/.test(line)) {
            steps += 1;
            const index = jobLines.indexOf(line);
            const stepLines = jobLines.slice(index, index + 6);
            if (!stepLines.some((candidate) => /^        timeout-minutes:\s*\d+/.test(candidate))) {
                errors.push(`step missing timeout-minutes: ${line.trim()}`);
            }
        }
    }
    if (steps === 0) errors.push('no deploy steps found');
}

if (errors.length > 0) {
    for (const error of errors) console.error(`::error::${error}`);
    process.exit(1);
}
console.log('Deploy job and all steps have bounded timeouts.');
