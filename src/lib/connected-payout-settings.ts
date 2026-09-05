export type ConnectedPayoutSchedule = {
  status: 'enabled' | 'disabled' | null;
  interval: 'daily' | 'weekly' | 'monthly' | 'manual' | null;
  weeklyPayoutDays: string[];
  monthlyPayoutDays: number[];
  delayDays: number | null;
  delayDaysOverride: number | null;
  summary: string | null;
};

function titleCase(input: string) {
  return input.charAt(0).toUpperCase() + input.slice(1);
}

function joinReadable(values: string[]) {
  if (values.length === 0) return '';
  if (values.length === 1) return values[0];
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(', ')}, and ${values[values.length - 1]}`;
}

function formatDelaySuffix(delayDays: number | null) {
  if (delayDays == null || Number.isNaN(delayDays)) return '';
  return ` after ${delayDays} business day${delayDays === 1 ? '' : 's'}`;
}

export function formatConnectedPayoutScheduleSummary(input: {
  interval: ConnectedPayoutSchedule['interval'];
  weeklyPayoutDays: string[];
  monthlyPayoutDays: number[];
  delayDays: number | null;
}) {
  const delaySuffix = formatDelaySuffix(input.delayDays);

  if (input.interval === 'daily') {
    return `Automatic payouts every day${delaySuffix}.`;
  }

  if (input.interval === 'weekly') {
    const days = input.weeklyPayoutDays.map(titleCase);
    return `Automatic payouts weekly on ${joinReadable(days) || 'your Stripe-selected day'}${delaySuffix}.`;
  }

  if (input.interval === 'monthly') {
    const days = input.monthlyPayoutDays.join(', ');
    return `Automatic payouts monthly on day ${days || 'configured in Stripe'}${delaySuffix}.`;
  }

  if (input.interval === 'manual') {
    return 'Automatic payouts are disabled. Funds remain in Stripe until a manual payout is created.';
  }

  return null;
}

export function serializeBalanceSettings(balanceSettings: any): ConnectedPayoutSchedule | null {
  if (!balanceSettings?.payments) {
    return null;
  }

  const payouts = balanceSettings.payments.payouts;
  const schedule = payouts?.schedule;
  const settlementTiming = balanceSettings.payments.settlement_timing;
  const delayDaysOverride =
    typeof settlementTiming?.delay_days_override === 'number'
      ? settlementTiming.delay_days_override
      : null;
  const delayDays =
    delayDaysOverride ??
    (typeof settlementTiming?.delay_days === 'number' ? settlementTiming.delay_days : null);

  const weeklyPayoutDays = Array.isArray(schedule?.weekly_payout_days)
    ? schedule.weekly_payout_days
    : [];
  const monthlyPayoutDays = Array.isArray(schedule?.monthly_payout_days)
    ? schedule.monthly_payout_days
    : [];
  const interval = schedule?.interval ?? null;

  return {
    status: payouts?.status ?? null,
    interval,
    weeklyPayoutDays,
    monthlyPayoutDays,
    delayDays,
    delayDaysOverride,
    summary: formatConnectedPayoutScheduleSummary({
      interval,
      weeklyPayoutDays,
      monthlyPayoutDays,
      delayDays,
    }),
  };
}

export async function getConnectedPayoutSchedule(
  stripe: any,
  stripeAccountId: string,
): Promise<ConnectedPayoutSchedule | null> {
  try {
    const balanceSettings = await stripe.balanceSettings.retrieve(
      {},
      { stripeAccount: stripeAccountId },
    );
    return serializeBalanceSettings(balanceSettings);
  } catch (err: any) {
    console.error(`Failed to retrieve balance settings for ${stripeAccountId}:`, err.message);
    return null;
  }
}
