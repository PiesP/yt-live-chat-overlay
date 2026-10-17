import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

type RecordValue = Record<string, unknown>;
const losslessJson = JSON as typeof JSON & {
  isRawJSON(value: unknown): boolean;
  rawJSON(source: string): object;
};

function isObject(value: unknown): value is RecordValue {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    !losslessJson.isRawJSON(value)
  );
}

function fail(message: string): never {
  throw new Error(message);
}

function normalize(report: unknown, category: string, scanStatus: number): RecordValue {
  if (!isObject(report) || report.version !== '2.1.0') fail('expected SARIF 2.1.0');
  const runs = report.runs;
  if (!Array.isArray(runs) || runs.length === 0) fail('expected at least one SARIF run');

  let resultCount = 0;
  for (const run of runs) {
    if (!isObject(run)) fail('invalid SARIF run');
    if (!isObject(run.tool)) fail('missing SARIF tool');
    const driver = run.tool.driver;
    if (!isObject(driver) || typeof driver.name !== 'string' || !driver.name) {
      fail('missing SARIF tool name');
    }
    const rules = driver.rules;
    if (driver.name !== 'Semgrep OSS' || !Array.isArray(rules) || rules.length === 0) {
      fail('unexpected Semgrep SARIF tool or rules');
    }
    const ruleIds = new Set<string>();
    for (const rule of rules) {
      if (!isObject(rule) || typeof rule.id !== 'string' || !rule.id || ruleIds.has(rule.id)) {
        fail('invalid SARIF rules');
      }
      ruleIds.add(rule.id);
    }
    const results = run.results;
    if (!Array.isArray(results)) fail('invalid SARIF results');
    for (const result of results) {
      if (
        !isObject(result) ||
        typeof result.ruleId !== 'string' ||
        !ruleIds.has(result.ruleId) ||
        !isObject(result.message) ||
        typeof result.message.text !== 'string'
      ) {
        fail('invalid SARIF results');
      }
    }
    const invocations = run.invocations;
    if (!Array.isArray(invocations) || invocations.length === 0) fail('missing SARIF invocation');
    for (const invocation of invocations) {
      if (!isObject(invocation) || invocation.executionSuccessful !== true) {
        fail('unsuccessful SARIF invocation');
      }
      const notifications =
        invocation.toolExecutionNotifications === undefined
          ? []
          : invocation.toolExecutionNotifications;
      if (
        !Array.isArray(notifications) ||
        notifications.some(
          (notification) => !isObject(notification) || notification.level === 'error'
        )
      ) {
        fail('SARIF tool execution error');
      }
    }
    resultCount += results.length;
    const details = run.automationDetails;
    if (details !== undefined && details !== null && !isObject(details)) {
      fail('invalid SARIF automation details');
    }
    run.automationDetails = { ...(details ?? {}), id: `${category}/` };
  }

  if (scanStatus === 1 && resultCount === 0) fail('findings exit without SARIF results');
  if (scanStatus === 0 && resultCount !== 0) fail('clean exit with SARIF results under --error');
  return report;
}

export function run(): number {
  const path = process.env.INPUT_SARIF_PATH;
  const category = process.env.INPUT_CATEGORY;
  const status = process.env.INPUT_SCANNER_STATUS;
  const output = process.env.GITHUB_OUTPUT;
  if (!path || !path.trim()) {
    console.error('Invalid Semgrep SARIF: missing SARIF path');
    return 2;
  }
  if (category !== 'semgrep/secrets' && category !== 'semgrep/full') {
    console.error('Invalid Semgrep SARIF: invalid category');
    return 2;
  }
  if (status !== '0' && status !== '1') {
    console.error('Invalid Semgrep SARIF: invalid scanner status');
    return 2;
  }
  if (!output || !output.trim()) {
    console.error('Invalid Semgrep SARIF: missing GITHUB_OUTPUT');
    return 2;
  }

  let report: RecordValue;
  try {
    const bytes = readFileSync(path);
    // Keep the BOM visible: Python's former utf-8 JSON reader rejected it.
    const source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    const parsed = JSON.parse(
      source,
      (_key: string, value: unknown, context?: { source?: string }) => {
        const raw = context?.source;
        // SARIF permits unrelated numeric metadata; preserve JSON integers beyond JS precision.
        return typeof value === 'number' &&
          !Number.isSafeInteger(value) &&
          raw &&
          /^-?(?:0|[1-9]\d*)$/.test(raw)
          ? losslessJson.rawJSON(raw)
          : value;
      }
    ) as unknown;
    report = normalize(parsed, category, Number(status));
  } catch (error) {
    const message =
      error instanceof SyntaxError
        ? 'invalid JSON or UTF-8'
        : error instanceof Error && !('code' in error)
          ? error.message
          : 'cannot read report';
    console.error(`Invalid Semgrep SARIF: ${message}`);
    return 2;
  }

  try {
    writeFileSync(path, JSON.stringify(report), 'utf8');
  } catch {
    console.error('Invalid Semgrep SARIF: cannot write report');
    return 2;
  }
  try {
    appendFileSync(output, `sarif-upload=true\ncategory=${category}\n`, 'utf8');
  } catch {
    console.error('Invalid Semgrep SARIF: cannot write action outputs');
    return 2;
  }
  return Number(status);
}
