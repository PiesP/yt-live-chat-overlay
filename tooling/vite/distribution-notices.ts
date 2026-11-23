// SPDX-License-Identifier: MIT
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
export const NOTICE_FILES = ['LICENSE', 'THIRD_PARTY_NOTICES.txt'] as const;
const notices = NOTICE_FILES.map((file) => readFileSync(resolve(root, file), 'utf8').trimEnd());
export const DISTRIBUTION_NOTICE_BANNER = [
  '/*!',
  ...notices
    .join('\n\n')
    .split('\n')
    .map((line) => (line ? `* ${line}` : '*')),
  '*/',
].join('\n');

export function assertDistributionNotice(source: string, artifact: string): void {
  if (!source.includes(DISTRIBUTION_NOTICE_BANNER)) {
    throw new Error(`${artifact} is missing the complete distribution notices.`);
  }
}

export function assertNoticeFile(
  contents: Buffer,
  name: (typeof NOTICE_FILES)[number],
  artifact: string
): void {
  if (!contents.equals(readFileSync(resolve(root, name)))) {
    throw new Error(`${artifact}/${name} differs from its source notice.`);
  }
}
