#!/usr/bin/env node

import { pathToFileURL } from 'node:url';

import { CPM_RUNTIME } from './runtime-config.mjs';

export function run(args, output = process.stdout, errorOutput = process.stderr) {
    if (args.length === 2 && args[0] === 'version' && args[1] === '--json') {
        output.write(`${JSON.stringify(CPM_RUNTIME)}\n`);
        return 0;
    }

    errorOutput.write('cpm_cli_usage: expected "version --json"\n');
    return 2;
}

if (process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href) {
    process.exitCode = run(process.argv.slice(2));
}
