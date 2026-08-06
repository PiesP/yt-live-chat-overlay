// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import type { ChatMessage } from '@app-types';
import { rendererLayout } from '@util/design-tokens';

export const BACKLOG_PRIORITY_OFFSET = 50;

/** Canonical priority used by queue ordering, overflow, and anti-block bypass. */
export function getMessagePriority(
  message: Pick<ChatMessage, 'kind'> & { readonly isBacklog?: boolean }
): number {
  let priority = rendererLayout.kindPriority[message.kind];
  if (message.isBacklog) priority -= BACKLOG_PRIORITY_OFFSET;
  return priority;
}
