#!/usr/bin/env node
import { runCli } from './cli.js';
import { serve } from './server.js';

const [, , cmd, ...rest] = process.argv;

if (!cmd || cmd === 'serve') {
  await serve();
} else {
  await runCli(cmd, rest);
}
