import { describe, it, expect } from 'vitest';
import { toWorkerConfig, SUPERCHAT_CARD_CONFIG, MEMBERSHIP_CARD_CONFIG } from '@renderer/card-config';

// ── helpers ──────────────────────────────────────────────────────────

const makeSuperChatMessage = (overrides = {}) => ({
  id: 'msg1',
  text: 'Thanks for the stream!',
  content: [{ type: 'text' as const, content: 'Thanks for the stream!' }],
  kind: 'superchat' as const,
  timestamp: 1000,
  author: 'TestUser',
  authorType: 'normal' as const,
  superChat: {
    amount: '$5.00',
    tier: 'blue' as const,
    headerBackgroundColor: '#0000FF',
    backgroundColor: '#0000CC',
  },
  ...overrides,
});

const makeMembershipMessage = (overrides = {}) => ({
  id: 'msg2',
  text: 'Welcome!',
  content: [{ type: 'text' as const, content: 'Welcome!' }],
  kind: 'membership' as const,
  timestamp: 2000,
  author: 'NewMember',
  authorType: 'member' as const,
  membershipHeader: 'New Member',
  ...overrides,
});

const makeSettings = (overrides = {}) =>
  ({
    showAuthor: { superChat: true, membership: true, text: true },
    superChatMaxBodyLines: 3,
    membershipMaxBodyLines: 2,
    showSuperChatAmount: true,
    ...overrides,
  } as unknown as Parameters<typeof toWorkerConfig>[2]);

// ── toWorkerConfig for SuperChat ─────────────────────────────────────

describe('toWorkerConfig (SuperChat)', () => {
  it('converts SUPERCHAT_CARD_CONFIG to worker format', () => {
    const msg = makeSuperChatMessage();
    const settings = makeSettings();
    const result = toWorkerConfig(SUPERCHAT_CARD_CONFIG, msg, settings);

    expect(result.background).toBe('gradient');
    expect(result.decoration).toBe('accentBar');
    expect(result.badgeEnabled).toBe(true);
    expect(result.authorShow).toBe(true);
    expect(result.bodyMaxLines).toBe(3); // from settings.superChatMaxBodyLines
    expect(result.showBadgeAmount).toBe(true);
    expect(result.needsGradientCache).toBe(true);
  });

  it('resolves accent bar color from callback', () => {
    const msg = makeSuperChatMessage();
    const settings = makeSettings();
    const result = toWorkerConfig(SUPERCHAT_CARD_CONFIG, msg, settings);

    expect(result.accentBar).toBeDefined();
    // Blue tier color — resolved accent bar color is nested inside accentBar
    const barColor = result.accentBar!.color;
    expect(barColor.b).toBeGreaterThan(barColor.r);
  });

  it('resolves textColor from auto to readable color', () => {
    const msg = makeSuperChatMessage();
    const settings = makeSettings();
    const result = toWorkerConfig(SUPERCHAT_CARD_CONFIG, msg, settings);

    // textColor is 'auto' → should resolve to either #000000 or #ffffff
    expect(['#000000', '#ffffff']).toContain(result.textColor);
  });

  it('hides author when settings.showAuthor.superChat is false', () => {
    const msg = makeSuperChatMessage();
    const settings = makeSettings({ showAuthor: { ...makeSettings().showAuthor, superChat: false } });
    const result = toWorkerConfig(SUPERCHAT_CARD_CONFIG, msg, settings);

    expect(result.authorShow).toBe(false);
  });

  it('hides badge amount when settings.showSuperChatAmount is false', () => {
    const msg = makeSuperChatMessage();
    const settings = makeSettings({ showSuperChatAmount: false });
    const result = toWorkerConfig(SUPERCHAT_CARD_CONFIG, msg, settings);

    expect(result.showBadgeAmount).toBe(false);
  });

  it('uses bodyMaxLines from settings', () => {
    const msg = makeSuperChatMessage();
    const settings = makeSettings({ superChatMaxBodyLines: 5 });
    const result = toWorkerConfig(SUPERCHAT_CARD_CONFIG, msg, settings);

    expect(result.bodyMaxLines).toBe(5);
  });
});

// ── toWorkerConfig for Membership ────────────────────────────────────

describe('toWorkerConfig (Membership)', () => {
  it('converts MEMBERSHIP_CARD_CONFIG to worker format', () => {
    const msg = makeMembershipMessage();
    const settings = makeSettings();
    const result = toWorkerConfig(MEMBERSHIP_CARD_CONFIG, msg, settings);

    expect(result.background).toBe('solid');
    expect(result.decoration).toBe('pulsingBorder');
    expect(result.badgeEnabled).toBe(false);
    expect(result.headerTagEnabled).toBe(true);
    expect(result.bodyMaxLines).toBe(2); // from settings.membershipMaxBodyLines
    expect(result.needsElapsed).toBe(true);
  });

  it('resolves author show from callback', () => {
    const msg = makeMembershipMessage({ author: 'Someone' });
    const settings = makeSettings();
    const result = toWorkerConfig(MEMBERSHIP_CARD_CONFIG, msg, settings);

    expect(result.authorShow).toBe(true);
  });

  it('hides author when message has no author', () => {
    const msg = makeMembershipMessage({ author: undefined });
    const settings = makeSettings();
    const result = toWorkerConfig(MEMBERSHIP_CARD_CONFIG, msg, settings);

    expect(result.authorShow).toBe(false);
  });

  it('uses bodyMaxLines from settings for membership', () => {
    const msg = makeMembershipMessage();
    const settings = makeSettings({ membershipMaxBodyLines: 4 });
    const result = toWorkerConfig(MEMBERSHIP_CARD_CONFIG, msg, settings);

    expect(result.bodyMaxLines).toBe(4);
  });

  it('has solid background with color', () => {
    const msg = makeMembershipMessage();
    const settings = makeSettings();
    const result = toWorkerConfig(MEMBERSHIP_CARD_CONFIG, msg, settings);

    expect(result.backgroundColor).toBeDefined();
    expect(result.backgroundAlpha).toBeDefined();
  });
});

// ── CardConfig constants structure ───────────────────────────────────

describe('SUPERCHAT_CARD_CONFIG', () => {
  it('has gradient background', () => {
    expect(SUPERCHAT_CARD_CONFIG.background).toBe('gradient');
    expect(SUPERCHAT_CARD_CONFIG.backgroundGradient).toBeDefined();
  });

  it('has accent bar decoration', () => {
    expect(SUPERCHAT_CARD_CONFIG.decoration).toBe('accentBar');
    expect(SUPERCHAT_CARD_CONFIG.accentBar).toBeDefined();
  });

  it('has badge configured', () => {
    expect(SUPERCHAT_CARD_CONFIG.badge).toBeDefined();
  });

  it('has textColor auto', () => {
    expect(SUPERCHAT_CARD_CONFIG.textColor).toBe('auto');
  });
});

describe('MEMBERSHIP_CARD_CONFIG', () => {
  it('has solid background', () => {
    expect(MEMBERSHIP_CARD_CONFIG.background).toBe('solid');
    expect(MEMBERSHIP_CARD_CONFIG.backgroundColor).toBeDefined();
  });

  it('has pulsing border decoration', () => {
    expect(MEMBERSHIP_CARD_CONFIG.decoration).toBe('pulsingBorder');
    expect(MEMBERSHIP_CARD_CONFIG.pulsingBorder).toBeDefined();
  });

  it('has header tag configured', () => {
    expect(MEMBERSHIP_CARD_CONFIG.headerTag).toBeDefined();
  });
});
