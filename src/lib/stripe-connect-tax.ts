import { env } from '../config/env.js';
import { AppError, ErrorCode } from '../plugins/error-handler.plugin.js';

const MAX_TAX_YEARS = 5;

type StripeTaxCapability = 'active' | 'inactive' | 'pending' | null;

export interface StripeTaxProfile {
  accountId: string;
  accountType: string | null;
  businessType: string | null;
  country: string | null;
  email: string | null;
  legalName: string | null;
  representativeName: string | null;
  supportEmail: string | null;
  supportPhone: string | null;
  website: string | null;
  defaultCurrency: string | null;
  taxIdProvided: boolean;
  vatIdProvided: boolean;
  address: string | null;
  taxReportingStatus: StripeTaxCapability;
  taxReporting1099K: StripeTaxCapability;
  taxReporting1099Misc: StripeTaxCapability;
  requirements: {
    currentlyDue: string[];
    pastDue: string[];
    eventuallyDue: string[];
    pendingVerification: string[];
    disabledReason: string | null;
  };
}

export interface StripeTaxDocumentItem {
  year: number;
  formType: '1099-NEC';
  status: 'check_in_stripe';
  accessMode: 'stripe_express_dashboard';
  description: string;
}

function formatAddress(address: any): string | null {
  if (!address) return null;

  const parts = [
    address.line1,
    address.line2,
    address.city,
    address.state,
    address.postal_code,
    address.country,
  ].filter(Boolean);

  return parts.length > 0 ? parts.join(', ') : null;
}

function getIndividualName(individual: any): string | null {
  if (!individual) return null;
  const parts = [individual.first_name, individual.last_name].filter(Boolean);
  if (parts.length > 0) return parts.join(' ');
  return individual.email ?? null;
}

export async function getStripeClient() {
  if (!env.STRIPE_SECRET_KEY) {
    throw new AppError(500, ErrorCode.INTERNAL_ERROR, 'Stripe is not configured');
  }

  const Stripe = (await import('stripe')).default;
  return new Stripe(env.STRIPE_SECRET_KEY);
}

export function buildTaxDocumentYears(startDate?: Date | string | null) {
  const lastCompletedYear = new Date().getFullYear() - 1;
  if (lastCompletedYear < 2000) return [];

  let startYear = lastCompletedYear;

  if (startDate) {
    const parsed = new Date(startDate);
    if (!Number.isNaN(parsed.getTime())) {
      startYear = parsed.getFullYear();
    }
  }

  const minYear = Math.max(startYear, lastCompletedYear - (MAX_TAX_YEARS - 1));
  if (minYear > lastCompletedYear) return [];

  const years: number[] = [];
  for (let year = lastCompletedYear; year >= minYear; year -= 1) {
    years.push(year);
  }
  return years;
}

export function buildTaxDocuments(params: {
  country?: string | null;
  startDate?: Date | string | null;
}): StripeTaxDocumentItem[] {
  if ((params.country ?? '').toUpperCase() !== 'US') {
    return [];
  }

  return buildTaxDocumentYears(params.startDate).map((year) => ({
    year,
    formType: '1099-NEC',
    status: 'check_in_stripe',
    accessMode: 'stripe_express_dashboard',
    description: 'Stripe hosts filed 1099-NEC forms in the connected account tax documents view.',
  }));
}

export function mapStripeTaxProfile(account: any): StripeTaxProfile {
  const businessType = account.business_type ?? null;
  const individualName = getIndividualName(account.individual);
  const legalName =
    account.company?.name ??
    individualName ??
    account.business_profile?.name ??
    account.settings?.dashboard?.display_name ??
    null;
  const address =
    formatAddress(account.company?.address) ??
    formatAddress(account.individual?.address) ??
    null;
  const taxReporting1099Misc = account.capabilities?.tax_reporting_us_1099_misc ?? null;
  const taxReporting1099K = account.capabilities?.tax_reporting_us_1099_k ?? null;

  return {
    accountId: account.id,
    accountType: account.type ?? null,
    businessType,
    country: account.country ?? null,
    email: account.email ?? null,
    legalName,
    representativeName: businessType === 'individual' ? individualName : null,
    supportEmail: account.business_profile?.support_email ?? account.email ?? null,
    supportPhone:
      account.business_profile?.support_phone ??
      account.company?.phone ??
      account.individual?.phone ??
      null,
    website: account.business_profile?.url ?? null,
    defaultCurrency: account.default_currency ?? null,
    taxIdProvided: Boolean(
      account.company?.tax_id_provided ??
      account.individual?.id_number_provided ??
      account.individual?.ssn_last_4_provided,
    ),
    vatIdProvided: Boolean(account.company?.vat_id_provided),
    address,
    taxReportingStatus: taxReporting1099Misc ?? taxReporting1099K ?? null,
    taxReporting1099K,
    taxReporting1099Misc,
    requirements: {
      currentlyDue: account.requirements?.currently_due ?? [],
      pastDue: account.requirements?.past_due ?? [],
      eventuallyDue: account.requirements?.eventually_due ?? [],
      pendingVerification: account.requirements?.pending_verification ?? [],
      disabledReason: account.requirements?.disabled_reason ?? null,
    },
  };
}

export async function createExpressDashboardLoginLink(accountId: string) {
  const stripe = await getStripeClient();
  const loginLink = await stripe.accounts.createLoginLink(accountId);
  return loginLink.url;
}
