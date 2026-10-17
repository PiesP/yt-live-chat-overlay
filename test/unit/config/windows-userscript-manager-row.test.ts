// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP
// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vite-plus/test';
// @ts-expect-error Portable Windows acceptance runtime is intentionally plain ESM.
import * as upgrade from '../../../validation/windows/release-upgrade/upgrade.mjs';

const scriptName = 'YouTube Live Chat Overlay';
const entry = (version: string) => `<tr class="scripttr">
  <td><span class="nameNname16">${scriptName}</span> <span>${version}</span></td>
</tr>`;

function matchingRows() {
  return [...document.querySelectorAll(upgrade.INSTALLED_SCRIPT_ROW_SELECTOR)].filter((row) =>
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
    expect(
      upgrade.requireInstalledScriptRow(
        rows.map((row) => row.textContent ?? ''),
        '0.45.5'
      )
    ).toMatchObject({
      version: '0.45.5',
    });
  });

  it('still rejects two sibling installations of the same identity', () => {
    document.body.innerHTML = `<table class="scripttable"><tbody>
      ${entry('0.45.5')}${entry('0.45.5')}
    </tbody></table>`;
    const rows = matchingRows();
    expect(rows).toHaveLength(2);
    expect(() =>
      upgrade.requireInstalledScriptRow(
        rows.map((row) => row.textContent ?? ''),
        '0.45.5'
      )
    ).toThrow('one installation');
  });
});
