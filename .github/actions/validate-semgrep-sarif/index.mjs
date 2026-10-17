import { run } from './validate.ts';

try {
  process.exitCode = run();
} catch {
  console.error('Invalid Semgrep SARIF: unexpected validator failure');
  process.exitCode = 2;
}
