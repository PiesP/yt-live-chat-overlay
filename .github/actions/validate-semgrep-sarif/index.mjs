import { run } from './validate.ts';

console.log(`Semgrep SARIF validator runtime: ${process.version} (${process.execPath})`);

try {
  process.exitCode = run();
} catch {
  console.error('Invalid Semgrep SARIF: unexpected validator failure');
  process.exitCode = 2;
}
