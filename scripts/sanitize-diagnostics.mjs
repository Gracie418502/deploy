#!/usr/bin/env node
/**
 * Sanitize kubectl diagnostics before they are uploaded as an artifact (#159).
 * Reads stdin, writes safe text to stdout.
 *
 * - Drops whole Kubernetes Secret objects.
 * - Redacts environment-style values whose key looks sensitive.
 * - Redacts Secret data/stringData maps that survived structural filtering.
 */
import { readFileSync } from 'node:fs';

const SENSITIVE_KEY = /(PASS|SECRET|TOKEN|KEY|CREDENTIAL|DSN|CONNECTION|PRIVATE|AUTH|COOKIE|SIGNATURE)/i;

export function sanitize(input) {
    const lines = input.split(/\r?\n/);
    const output = [];
    let skippingSecret = false;
    let inSecretData = false;
    let secretDataIndent = -1;
    let lastEnvName = '';

    for (const line of lines) {
        // Strip document-level Secrets (YAML or kubectl table output).
        if (/^kind:\s*Secret\s*$/.test(line) || /^secret\b/i.test(line)) {
            skippingSecret = true;
            continue;
        }
        if (skippingSecret) {
            if (/^---\s*$/.test(line)) {
                skippingSecret = false;
                inSecretData = false;
            }
            continue;
        }

        const indentMatch = line.match(/^(\s*)/);
        const indent = indentMatch ? indentMatch[1].length : 0;
        if (inSecretData && indent <= secretDataIndent && line.trim() !== '') {
            inSecretData = false;
        }
        if (/^\s*(data|stringData):\s*$/.test(line)) {
            inSecretData = true;
            secretDataIndent = indent;
            output.push(line);
            continue;
        }
        if (inSecretData) {
            output.push(`${' '.repeat(indent)}${line.trim().split(':')[0]}: [REDACTED]`);
            continue;
        }

        // env entries: remember the preceding `name:` so the following
        // `value:` can be redacted when the key is sensitive.
        const envName = line.match(/^\s*-?\s*name:\s*(\S+)/);
        if (envName) lastEnvName = envName[1];
        if (/^\s*value:\s*/.test(line) && SENSITIVE_KEY.test(lastEnvName)) {
            output.push(line.replace(/^(\s*value:\s*).*$/, '$1[REDACTED]'));
            continue;
        }

        // env: [{name: X, value: Y}] and "KEY=value" / "KEY: value" pairs.
        let safe = line
            .replace(/(\b(?:value|valueFrom)\s*:\s*)('[^']*'|"[^"]*"|[^\s,}]+)/gi, (full, prefix) =>
                SENSITIVE_KEY.test(line) ? `${prefix}[REDACTED]` : full,
            )
            .replace(/\b([A-Za-z0-9_]+)\s*=\s*([^\s;'"]+)/g, (full, key) =>
                SENSITIVE_KEY.test(key) ? `${key}=[REDACTED]` : full,
            )
            .replace(/\b([A-Za-z0-9_]+)\s*:\s*(\S+)/g, (full, key) =>
                SENSITIVE_KEY.test(key) ? `${key}: [REDACTED]` : full,
            );

        // Credentials embedded in URLs.
        safe = safe.replace(/(https?:\/\/)[^@/\s]+@/gi, '$1[REDACTED]@');
        output.push(safe);
    }
    return output.join('\n');
}

function main() {
    const input = readFileSync(0, 'utf8');
    process.stdout.write(sanitize(input));
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
    main();
}
