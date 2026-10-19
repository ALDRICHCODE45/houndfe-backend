import { InvalidArgumentError } from '../../shared/domain/domain-error';

export interface BotEligibilityRule {
  type: string;
  method: string;
  appliesTo: readonly string[];
  customerScopes: readonly string[];
  allowsPriceLists: boolean;
  allowsDaysOfWeek: boolean;
}

export const BOT_ELIGIBILITY_RULES: readonly BotEligibilityRule[] = [
  {
    type: 'PRODUCT_DISCOUNT',
    method: 'AUTOMATIC',
    appliesTo: ['PRODUCTS'],
    customerScopes: ['ALL'],
    allowsPriceLists: false,
    allowsDaysOfWeek: false,
  },
];

interface BotEligibilityInput {
  type: string;
  method: string;
  appliesTo?: string | null;
  customerScope?: string;
  priceLists?: readonly unknown[];
  daysOfWeek?: readonly unknown[];
}

function unsupportedCondition(input: BotEligibilityInput): string | null {
  let rules = BOT_ELIGIBILITY_RULES;
  const conditions: [string, (rule: BotEligibilityRule) => boolean][] = [
    ['type', (rule) => rule.type === input.type],
    ['method', (rule) => rule.method === input.method],
    ['appliesTo', (rule) => rule.appliesTo.includes(input.appliesTo ?? '')],
    [
      'customerScope',
      (rule) => rule.customerScopes.includes(input.customerScope ?? 'ALL'),
    ],
    [
      'priceLists',
      (rule) => rule.allowsPriceLists || !input.priceLists?.length,
    ],
    [
      'daysOfWeek',
      (rule) => rule.allowsDaysOfWeek || !input.daysOfWeek?.length,
    ],
  ];
  for (const [condition, matches] of conditions) {
    rules = rules.filter(matches);
    if (rules.length === 0) return condition;
  }
  return null;
}

export function isBotEligibilitySupported(input: BotEligibilityInput): boolean {
  return unsupportedCondition(input) === null;
}

export function assertBotEligibilitySupported(
  input: BotEligibilityInput,
): void {
  const condition = unsupportedCondition(input);
  if (condition) {
    throw new InvalidArgumentError(
      `Bot eligibility does not support this promotion's ${condition}`,
      'BOT_ELIGIBILITY_UNSUPPORTED',
    );
  }
}
