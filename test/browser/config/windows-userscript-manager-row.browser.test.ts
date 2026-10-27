// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { afterEach, describe, expect, it } from 'vite-plus/test';

import { INSTALLED_SCRIPT_ROW_SELECTOR } from '../../../validation/windows/release-upgrade/manager-row.ts';

const scriptName = 'YouTube Live Chat Overlay';
const entry = (version: string) => `<tr class="scripttr">
  <td><span class="nameNname16">${scriptName}</span> <span>${version}</span></td>
</tr>`;

function matchingRows() {
  return [...document.querySelectorAll(INSTALLED_SCRIPT_ROW_SELECTOR)].filter((row) =>
    [...row.querySelectorAll('span.nameNname16')].some(
      (name) => name.textContent?.trim() === scriptName
    )
  );
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('Tampermonkey dashboard installed entry', () => {
  it('counts one actual entry under a nested table layout once', () => {
    document.body.innerHTML = `<table><tbody><tr class="layout"><td>
      <table class="scripttable"><tbody>${entry('0.45.5')}</tbody></table>
    </td></tr></tbody></table>`;
    expect(document.querySelectorAll('tr')).toHaveLength(2);
    const rows = matchingRows();
    expect(rows).toHaveLength(1);
    expect(rows.map((row) => row.textContent?.trim())).toEqual([`${scriptName} 0.45.5`]);
  });

  it('still rejects two sibling installations of the same identity', () => {
    document.body.innerHTML = `<table class="scripttable"><tbody>
      ${entry('0.45.5')}${entry('0.45.5')}
    </tbody></table>`;
    const rows = matchingRows();
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.textContent?.trim())).toEqual([
      `${scriptName} 0.45.5`,
      `${scriptName} 0.45.5`,
    ]);
  });
});
