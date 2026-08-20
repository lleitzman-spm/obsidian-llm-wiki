#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deploy, rollback, defaultOptions } from './deployer.mjs';

function parseArgs(argv) {
  const options = defaultOptions(path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url)))));
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--write') options.write = true;
    else if (arg === '--source' || arg === '--vault' || arg === '--operation') {
      const value = argv[++index];
      if (!value) throw new Error(`${arg} requires a value`);
      if (arg === '--source') options.sourceDir = value;
      if (arg === '--vault') options.vaultDir = value;
      if (arg === '--operation') options.operation = value;
    } else if (arg === '--help' || arg === '-h') options.help = true;
    else positional.push(arg);
  }
  if (positional.length > 1 || (positional[0] && positional[0] !== 'deploy' && positional[0] !== 'rollback')) throw new Error(`unknown argument: ${positional.join(' ')}`);
  options.command = positional[0] || 'deploy';
  return options;
}

function printHelp() {
  console.log(`Controlled Karpathy LLM Wiki deployer\n\nUsage:\n  node tools/deploy/deploy-plugin.mjs deploy [--source DIR] [--vault DIR] [--write]\n  node tools/deploy/deploy-plugin.mjs rollback --operation DIR [--vault DIR] [--write]\n\nDry-run is the default. --write is required for any live file mutation.`);
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) printHelp();
  else {
    const result = options.command === 'rollback' ? await rollback(options) : await deploy(options);
    console.log(JSON.stringify(result, null, 2));
  }
} catch (error) {
  console.error(`deploy-plugin: ${error.message}`);
  process.exitCode = 1;
}
