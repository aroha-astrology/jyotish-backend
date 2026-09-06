import { sql } from 'drizzle-orm';
import {
  pgTable,
  uuid,
  text,
  timestamp,
  date,
  time,
  jsonb,
  boolean,
  integer,
  smallint,
  doublePrecision,
  index,
  uniqueIndex,
  primaryKey,
  pgEnum,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import crypto from 'node:crypto';
import type { Category, CategoryReading, PanchangData } from '@aroha-astrology/shared';

/* -------------------------------------------------------------------------- */
/* Enums                                                                       */
/* -------------------------------------------------------------------------- */

/** "AR-" + 8 hex chars — short enough to read over chat/email, collision-safe enough (16^8
 * space) for a support-facing identifier that only needs to be unique, not secret. */
function generateOrderReference(): string {
  return `AR-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

export const genderEnum = pgEnum('gender', ['male', 'female', 'other']);

/** Which zodiac/tradition the user's charts are computed against. */
export const preferredSystemEnum = pgEnum('preferred_system', ['vedic', 'western']);

/** Sidereal precession-offset model (Vedic). Read-time default: 'lahiri'. */
export const preferredAyanamsaEnum = pgEnum('preferred_ayanamsa', [
  'lahiri',
  'raman',
  'krishnamurti',
  'yukteshwar',
  'true_chitrapaksha',
  'fagan_bradley',
]);

/** Which lunar node Rahu/Ketu are computed from. NULL = use the server default. */
export const preferredLunarNodeEnum = pgEnum('preferred_lunar_node', ['mean', 'true']);

/** Bhava/house cusp convention — union of Vedic + Western schools. */
export const houseSystemEnum = pgEnum('house_system', [
  'whole_sign',
  'equal',
  'placidus',
  'koch',
  'campanus',
  'regiomontanus',
  'porphyry',
  'topocentric',
  'alcabitius',
  'sripati',
  'kp_placidus',
]);

/** Diagram style for rendering a Vedic chart. */
export const preferredChartStyleEnum = pgEnum('preferred_chart_style', [
  'north_indian',
  'south_indian',
  'east_indian',
]);

export const preferredDashaSystemEnum = pgEnum('preferred_dasha_system', [
  'vimshottari',
  'yogini',
  'ashtottari',
  'kalachakra',
  'chara',
]);

export const preferredDashaYearLengthEnum = pgEnum('preferred_dasha_year_length', [
  'savana_360',
  'solar_365_25',
  'drik_365_2425',
]);

/** Rahu/Ketu node convention. */
export const preferredNodeTypeEnum = pgEnum('preferred_node_type', ['mean', 'true']);

/** Amanta vs Purnimanta lunar-month reckoning. */
export const preferredCalendarLocaleEnum = pgEnum('preferred_calendar_locale', [
  'amanta',
  'purnimanta',
]);

/**
 * Confidence in a recorded birth time. `unknown` is a valid terminal state:
 * the profile can complete with no `time_of_birth` when accuracy is `unknown`.
 */
export const birthTimeAccuracyEnum = pgEnum('birth_time_accuracy', [
  'exact',
  'approximate',
  'unknown',
]);

export const birthTimeSourceEnum = pgEnum('birth_time_source', [
  'birth_certificate',
  'hospital_record',
  'family_memory',
  'rectified',
  'unknown',
]);

export const birthTimeRectificationConfidenceEnum = pgEnum('birth_time_rectification_confidence', [
  'low',
  'medium',
  'high',
]);

export const birthLocationAccuracyEnum = pgEnum('birth_location_accuracy', [
  'exact',
  'city',
  'region',
  'unknown',
]);

export const relationshipStatusEnum = pgEnum('relationship_status', [
  'single',
  'in_relationship',
  'engaged',
  'married',
  'divorced',
  'widowed',
  'separated',
  'complicated',
  'prefer_not_to_say',
]);

export const partnerSeekingIntentEnum = pgEnum('partner_seeking_intent', [
  'not_seeking',
  'exploring',
  'seeking_marriage',
]);

export const onboardingStatusEnum = pgEnum('onboarding_status', [
  'not_started',
  'in_progress',
  'completed',
  'skipped',
]);

export const platformEnum = pgEnum('platform', ['ios', 'android', 'web']);

export const birthProfileRelationshipEnum = pgEnum('birth_profile_relationship', [
  'partner',
  'prospective_match',
  'spouse',
  'child',
  'parent',
  'sibling',
  'friend',
  'other',
]);

export const consentTypeEnum = pgEnum('consent_type', [
  'terms',
  'privacy',
  'marketing',
  'data_processing',
  'whatsapp',
  // Realtime voice: streaming the user's live speech to Google. A separate
  // grant from 'data_processing', not a subset of it — see the
  // users.voiceConsentAt column comment for why it cannot be inherited.
  'voice',
]);

export const consentActionEnum = pgEnum('consent_action', ['granted', 'withdrawn']);

/* -------------------------------------------------------------------------- */
/* JSONB value-object shapes                                                   */
/* -------------------------------------------------------------------------- */

/**
 * A geocoded place. Used for `place_of_birth` (immutable) and
 * `current_location` (mutable residence). lat/lon/tz are required chart inputs;
 * the rest are optional geocoder metadata.
 */
export type PlaceOfBirth = {
  name: string;
  lat: number;
  lon: number;
  /** IANA timezone, e.g. "Asia/Kolkata". */
  tz: string;
  placeId?: string;
  /** ISO 3166-1 alpha-2. */
  countryCode?: string;
  /** Primary administrative division (state/province). */
  admin1?: string;
  source?: 'geocoded' | 'manual';
};

/** Per-category channel toggles for notifications. */
export type NotificationChannelPrefs = {
  push?: boolean;
  email?: boolean;
  whatsapp?: boolean;
  sms?: boolean;
};

/**
 * UX-layer notification toggles. Marketing/WhatsApp sends must ALSO pass the
 * legal consent gate (`marketingConsentAt` / `whatsappOptInAt`), not just this.
 */
export type NotificationPrefs = {
  dailyHoroscope?: NotificationChannelPrefs;
  transitAlerts?: NotificationChannelPrefs;
  muhurta?: NotificationChannelPrefs;
  marketing?: NotificationChannelPrefs;
};

/** Do-not-disturb window, interpreted in the user's current timezone. */
export type QuietHours = {
  /** 'HH:mm' local. */
  start: string;
  /** 'HH:mm' local. */
  end: string;
};

/** Western chart-rendering input preferences (parameterize, never store outputs). */
export type ChartPreferences = {
  defaultChartType?: string;
  relocationPlace?: PlaceOfBirth;
  aspectsToAngles?: boolean;
  /** Aspect name -> orb in degrees. */
  orbs?: Record<string, number>;
  bodies?: {
    chiron?: boolean;
    lilith?: boolean;
    ceres?: boolean;
    pallas?: boolean;
    juno?: boolean;
    vesta?: boolean;
    arabicParts?: boolean;
    vertex?: boolean;
    midpoints?: boolean;
  };
  detectAspectPatterns?: boolean;
};

/* -------------------------------------------------------------------------- */
/* users — the account holder                                                  */
/* -------------------------------------------------------------------------- */

export const users = pgTable(
  'users',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    firebaseUid: text('firebase_uid').notNull().unique(),
    // Encrypted at rest (field-level encryption, see src/lib/crypto). Lookups
    // go through phoneE164Hash (a deterministic HMAC blind index) instead,
    // since AES-GCM ciphertext is non-deterministic and can't back a unique
    // constraint or an equality WHERE clause directly.
    phoneE164: text('phone_e164'),
    phoneE164Hash: text('phone_e164_hash').unique(),

    // --- identity / profile ------------------------------------------------
    displayName: text('display_name'),
    gender: genderEnum('gender'),
    email: text('email'),
    avatarUrl: text('avatar_url'),

    // --- birth event (chart inputs) -----------------------------------------
    // dateOfBirth/timeOfBirth/placeOfBirth are `text` (not date/time/jsonb)
    // because they hold an encrypted blob, not the raw value — the repo layer
    // (users.repo.ts) transparently encrypts on write and decrypts on read,
    // so every other layer of the app still sees a plain date/time string or
    // PlaceOfBirth object exactly as before.
    dateOfBirth: text('date_of_birth'),
    timeOfBirth: text('time_of_birth'),
    placeOfBirth: text('place_of_birth').$type<PlaceOfBirth>(),
    birthTimeAccuracy: birthTimeAccuracyEnum('birth_time_accuracy'),
    birthTimeSource: birthTimeSourceEnum('birth_time_source'),
    birthTimeRectified: boolean('birth_time_rectified'),
    birthTimeRectificationConfidence: birthTimeRectificationConfidenceEnum(
      'birth_time_rectification_confidence',
    ),
    birthLocationAccuracy: birthLocationAccuracyEnum('birth_location_accuracy'),
    // null = the user's one allowed birth-detail edit (DOB/time/place) is
    // still available; set the first (and only) time they use it.
    birthDetailsEditedAt: timestamp('birth_details_edited_at', { withTimezone: true }),
    gotra: text('gotra'),
    sankalpaName: text('sankalpa_name'),

    // --- astrology calculation preferences (read-time defaults; nullable) --
    preferredSystem: preferredSystemEnum('preferred_system'),
    preferredAyanamsa: preferredAyanamsaEnum('preferred_ayanamsa'),
    /** Per-user lunar node override; NULL falls back to LUNAR_NODE_TYPE. */
    preferredLunarNode: preferredLunarNodeEnum('preferred_lunar_node'),
    preferredHouseSystem: houseSystemEnum('preferred_house_system'),
    preferredChartStyle: preferredChartStyleEnum('preferred_chart_style'),
    preferredDashaSystem: preferredDashaSystemEnum('preferred_dasha_system'),
    preferredDashaYearLength: preferredDashaYearLengthEnum('preferred_dasha_year_length'),
    preferredNodeType: preferredNodeTypeEnum('preferred_node_type'),
    preferredCalendarLocale: preferredCalendarLocaleEnum('preferred_calendar_locale'),
    chartPreferences: jsonb('chart_preferences').$type<ChartPreferences>(),

    // --- current residence (transits / daily horoscope) -------------------
    currentLocation: jsonb('current_location').$type<PlaceOfBirth>(),
    currentLocationUpdatedAt: timestamp('current_location_updated_at', { withTimezone: true }),
    currentTimezone: text('current_timezone'),
    currentCountry: text('current_country'),

    // --- localization ------------------------------------------------------
    locale: text('locale'),
    contentLanguage: text('content_language'),

    // --- engagement / personalization -------------------------------------
    dailyHoroscopeSendHourLocal: time('daily_horoscope_send_hour_local'),
    interestAreas: text('interest_areas').array().$type<string[]>(),
    relationshipStatus: relationshipStatusEnum('relationship_status'),
    // Self-reported income ranges, collected as a single tap in chat when a
    // money question needs a scale to be read against (see lib/chat-income.ts
    // for the fixed bracket table these codes come from). Plain text, not an
    // enum: the brackets are a product/market decision that will be retuned,
    // and re-tuning a pgEnum means a migration dance for a column nothing
    // joins on. Null means never asked or declined.
    incomeBracket: text('income_bracket'),
    familyIncomeBracket: text('family_income_bracket'),
    partnerSeekingIntent: partnerSeekingIntentEnum('partner_seeking_intent'),
    notificationPrefs: jsonb('notification_prefs').$type<NotificationPrefs>(),
    quietHours: jsonb('quiet_hours').$type<QuietHours>(),

    // --- onboarding funnel -------------------------------------------------
    onboardingStatus: onboardingStatusEnum('onboarding_status'),
    onboardingStep: text('onboarding_step'),
    onboardingCompletedAt: timestamp('onboarding_completed_at', { withTimezone: true }),
    profileCompletedAt: timestamp('profile_completed_at', { withTimezone: true }),

    // --- product tour ------------------------------------------------------
    // Ids of the per-screen tours this user has finished (see the frontend's
    // components/tour/tour-registry.ts). One column rather than a boolean per
    // tour so adding an 11th tour is a frontend-only change.
    toursCompleted: jsonb('tours_completed').$type<string[]>().notNull().default([]),

    // --- activity / client -------------------------------------------------
    lastActiveAt: timestamp('last_active_at', { withTimezone: true }),
    streakCount: integer('streak_count'),
    streakLastDay: date('streak_last_day'),
    appVersion: text('app_version'),
    platform: platformEnum('platform'),
    /** Client IP seen on the most recent activity heartbeat — used only to re-resolve geo below when it changes. */
    lastIp: text('last_ip'),
    /** IP-geolocation cache, refreshed only when lastIp changes (see recordActivityHeartbeat). Best-effort; null until the first heartbeat resolves. */
    geoCountry: text('geo_country'),
    geoCity: text('geo_city'),
    geoResolvedAt: timestamp('geo_resolved_at', { withTimezone: true }),
    walletBalancePaise: integer('wallet_balance_paise').notNull().default(50000),
    unlockedHouses: integer('unlocked_houses')
      .array()
      .notNull()
      .default(sql`ARRAY[]::integer[]`),
    /** Set the moment the user spends credits to unlock the gemstone report; null = still locked. One-time, whole-report unlock. */
    gemstoneUnlockedAt: timestamp('gemstone_unlocked_at', { withTimezone: true }),
    /** Body weight (kg) captured at gemstone-unlock time — drives the recommended-carat calculation (see recommendedGemstoneCarats in astro-engine/gemstones.ts). Null for users who unlocked before this field existed, or never wore a physical gemstone. Stored for reuse elsewhere (not just this one calculation). */
    gemstoneWeightKg: doublePrecision('gemstone_weight_kg'),

    // --- next-report vote (2026-09-05) --------------------------------------
    // One-time, account-level: which report the user said they want next, asked
    // on exit from a report they just read (see app/reports/[id]/page.tsx on the
    // frontend). Null = never asked, or asked and the prompt is still pending —
    // the WHERE ... IS NULL guard in recordNextReportVote (users.repo.ts) is the
    // real "don't ask again" enforcement, not any client-side flag.
    nextReportVote: text('next_report_vote'),
    nextReportVotedAt: timestamp('next_report_voted_at', { withTimezone: true }),

    // --- multi-profile (2026-07-18) ----------------------------------------
    // NULL = the primary/self profile (this users row) is currently active;
    // a non-null id points at a row in birth_profiles. birthProfiles is
    // defined later in this file, so this uses Drizzle's forward-reference
    // callback form (AnyPgColumn return type) rather than a direct `.id`.
    activeProfileId: uuid('active_profile_id').references((): AnyPgColumn => birthProfiles.id, {
      onDelete: 'set null',
    }),

    // --- acquisition / referral -------------------------------------------
    referralSource: text('referral_source'),
    referredByCode: text('referred_by_code'),
    referralCode: text('referral_code'),
    referralEarningsPaise: integer('referral_earnings_paise').notNull().default(0),
    /** Set when the low-balance share-nudge push has been sent since the wallet last recovered to >= the threshold; cleared once it does. Gates one send per dip, see low-balance-alert.service.ts. */
    lowBalanceAlertedAt: timestamp('low_balance_alerted_at', { withTimezone: true }),

    // --- consent (current effective state; history in user_consent_log) ----
    marketingConsentAt: timestamp('marketing_consent_at', { withTimezone: true }),
    marketingConsentRevokedAt: timestamp('marketing_consent_revoked_at', { withTimezone: true }),
    whatsappOptInAt: timestamp('whatsapp_opt_in_at', { withTimezone: true }),
    whatsappOptInRevokedAt: timestamp('whatsapp_opt_in_revoked_at', { withTimezone: true }),
    dataProcessingConsentAt: timestamp('data_processing_consent_at', { withTimezone: true }),
    dataProcessingConsentRevokedAt: timestamp('data_processing_consent_revoked_at', {
      withTimezone: true,
    }),
    termsAcceptedAt: timestamp('terms_accepted_at', { withTimezone: true }),
    termsVersion: text('terms_version'),
    privacyPolicyAcceptedAt: timestamp('privacy_policy_accepted_at', { withTimezone: true }),
    privacyPolicyVersion: text('privacy_policy_version'),
    // Realtime voice (Gemini Live) — a SEPARATE, narrower grant than
    // dataProcessingConsentAt above, and deliberately not folded into it.
    // Voice sends a live recording of the user's speech to a third party
    // (Google) on a preview tier whose traffic may be used to improve that
    // third party's products, which is materially more than the general
    // data-processing consent covers. Existing users must therefore opt in
    // explicitly rather than inheriting it — which a null here gives us for
    // free. Both the `paid.voiceChat` feature flag AND this must be present
    // before a voice session can start.
    voiceConsentAt: timestamp('voice_consent_at', { withTimezone: true }),
    voiceConsentRevokedAt: timestamp('voice_consent_revoked_at', { withTimezone: true }),

    // --- lifecycle ---------------------------------------------------------
    // Set when the user taps Delete Account. Deletion is no longer immediate:
    // this files a request, Telegram tells an admin, and the erasure only runs
    // when the admin approves it in the bot. While it is non-null the account
    // still works, but we stop spending on it — no push (device-tokens.repo.ts)
    // and no horoscope generation (horoscope.repo.ts). Cleared on approve
    // (erasure done) or reject (request withdrawn); `anonymizedAt` below is the
    // permanent record that an erasure actually happened.
    deletionRequestedAt: timestamp('deletion_requested_at', { withTimezone: true }),
    anonymizedAt: timestamp('anonymized_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => ({
    // firebase_uid and phone_e164_hash are already backed by unique-constraint
    // indexes (.unique()), so no separate plain index is needed.
    emailLowerUnique: uniqueIndex('users_email_lower_unique')
      .on(sql`lower(${table.email})`)
      .where(sql`${table.deletedAt} is null and ${table.email} is not null`),
    referralCodeUnique: uniqueIndex('users_referral_code_unique')
      .on(table.referralCode)
      .where(sql`${table.referralCode} is not null`),
    referredByCodeIdx: index('users_referred_by_code_idx').on(table.referredByCode),
    deletionRequestedAtIdx: index('users_deletion_requested_at_idx')
      .on(table.deletionRequestedAt)
      .where(sql`${table.deletionRequestedAt} is not null`),
  }),
);

export type UserRow = typeof users.$inferSelect;
export type NewUserRow = typeof users.$inferInsert;

/* -------------------------------------------------------------------------- */
/* birth_profiles — saved charts for OTHER people (matching / family)          */
/* -------------------------------------------------------------------------- */

export const birthProfiles = pgTable(
  'birth_profiles',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    ownerUserId: uuid('owner_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    relationship: birthProfileRelationshipEnum('relationship'),
    displayName: text('display_name'),
    gender: genderEnum('gender'),
    // Encrypted at rest — same repo-layer transparent encrypt/decrypt as
    // users.dateOfBirth/timeOfBirth/placeOfBirth, see the comment there.
    dateOfBirth: text('date_of_birth'),
    timeOfBirth: text('time_of_birth'),
    placeOfBirth: text('place_of_birth').$type<PlaceOfBirth>(),
    birthTimeAccuracy: birthTimeAccuracyEnum('birth_time_accuracy'),
    birthTimeSource: birthTimeSourceEnum('birth_time_source'),
    birthLocationAccuracy: birthLocationAccuracyEnum('birth_location_accuracy'),
    gotra: text('gotra'),
    /** Owner attests they may store this third party's birth data. */
    addedWithConsent: boolean('added_with_consent'),
    notes: text('notes'),
    // --- multi-profile unlock state (2026-07-18) ---------------------------
    // Mirrors users.unlockedHouses / users.gemstoneUnlockedAt for the primary
    // profile — each additional profile tracks its own house/gemstone unlock
    // state independently. Nullable (unlike the users columns, which are
    // NOT NULL with defaults): a fresh additional profile simply has none
    // unlocked yet, and service-layer code should treat null the same as an
    // empty array / not-yet-unlocked.
    unlockedHouses: integer('unlocked_houses').array(),
    /** Set the moment the owner spends credits to unlock this profile's gemstone report; null = still locked. */
    gemstoneUnlockedAt: timestamp('gemstone_unlocked_at', { withTimezone: true }),
    /** Mirrors users.gemstoneWeightKg — see that column's comment. */
    gemstoneWeightKg: doublePrecision('gemstone_weight_kg'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => ({
    ownerIdx: index('birth_profiles_owner_user_id_idx')
      .on(table.ownerUserId)
      .where(sql`${table.deletedAt} is null`),
  }),
);

export type BirthProfileRow = typeof birthProfiles.$inferSelect;
export type NewBirthProfileRow = typeof birthProfiles.$inferInsert;

/* -------------------------------------------------------------------------- */
/* device_push_tokens — multi-device push registrations                        */
/* -------------------------------------------------------------------------- */

export const devicePushTokens = pgTable(
  'device_push_tokens',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    token: text('token').notNull(),
    platform: platformEnum('platform').notNull(),
    deviceId: text('device_id'),
    locale: text('locale'),
    appVersion: text('app_version'),
    osVersion: text('os_version'),
    /** OS-level push permission state on this device. */
    pushEnabled: boolean('push_enabled'),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (table) => ({
    userIdx: index('device_push_tokens_user_id_idx')
      .on(table.userId)
      .where(sql`${table.revokedAt} is null`),
    tokenUnique: uniqueIndex('device_push_tokens_token_unique')
      .on(table.token)
      .where(sql`${table.revokedAt} is null`),
  }),
);

export type DevicePushTokenRow = typeof devicePushTokens.$inferSelect;
export type NewDevicePushTokenRow = typeof devicePushTokens.$inferInsert;

/* -------------------------------------------------------------------------- */
/* user_consent_log — append-only consent audit trail                          */
/* -------------------------------------------------------------------------- */

export const userConsentLog = pgTable(
  'user_consent_log',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: uuid('user_id')
      .notNull()
      // RESTRICT, not CASCADE: an append-only audit trail must survive even a
      // hard delete of the user row. Erasure scrubs PII via users.anonymizedAt.
      .references(() => users.id, { onDelete: 'restrict' }),
    consentType: consentTypeEnum('consent_type').notNull(),
    action: consentActionEnum('action').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    policyVersion: text('policy_version'),
    sourceIp: text('source_ip'),
    userAgent: text('user_agent'),
  },
  (table) => ({
    userOccurredIdx: index('user_consent_log_user_id_occurred_at_idx').on(
      table.userId,
      table.occurredAt,
    ),
  }),
);

export type UserConsentLogRow = typeof userConsentLog.$inferSelect;
export type NewUserConsentLogRow = typeof userConsentLog.$inferInsert;

/* -------------------------------------------------------------------------- */
/* subscription_plans — billing tiers                                          */
/* -------------------------------------------------------------------------- */

export const subscriptionPlanStatusEnum = pgEnum('subscription_status', [
  'active',
  'cancelled',
  'expired',
  'trial',
]);

export const subscriptionPlans = pgTable('subscription_plans', {
  id: uuid('id')
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  name: text('name').notNull(),
  monthlyPrice: integer('monthly_price').notNull().default(0),
  features: jsonb('features').$type<Record<string, unknown>>().default({}),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .default(sql`now()`),
});

export const userSubscriptions = pgTable(
  'user_subscriptions',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    planId: uuid('plan_id')
      .notNull()
      .references(() => subscriptionPlans.id),
    status: subscriptionPlanStatusEnum('status').notNull().default('active'),
    startedAt: timestamp('started_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (table) => ({
    userIdx: index('user_subscriptions_user_id_idx').on(table.userId),
  }),
);

/* -------------------------------------------------------------------------- */
/* credit_transactions — token wallet ledger                                   */
/* -------------------------------------------------------------------------- */

export const walletTransactions = pgTable(
  'wallet_transactions',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    delta: integer('delta').notNull(),
    reason: text('reason').notNull(),
    balanceAfter: integer('balance_after').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    expiredAt: timestamp('expired_at', { withTimezone: true }),
    /**
     * How much of THIS grant is still unspent — set only on credit rows that
     * carry an `expiresAt`, NULL on everything else (purchases, refunds,
     * non-expiring bonuses, every debit). Turns an expiring grant into a
     * spendable lot: a debit drains the soonest-expiring lot first
     * (`consumeExpiringCredits` in users.repo.ts), so the expiry sweep claws
     * back only what was never used instead of `min(granted, balance)` —
     * which used to take a spent bonus back out of the user's paid balance.
     *
     * `users.walletBalancePaise` remains the single authoritative spendable
     * total; this is expiry accounting only. Lots can therefore sum to less
     * than the balance (paid top-ups have no lot) but never to more.
     */
    remainingPaise: integer('remaining_paise'),
  },
  (table) => ({
    userIdx: index('wallet_transactions_user_id_idx').on(table.userId),
  }),
);

/* -------------------------------------------------------------------------- */
/* gift_campaigns — admin-managed festival/occasion wallet-credit campaigns    */
/* -------------------------------------------------------------------------- */

export const giftCampaignDeliveryModeEnum = pgEnum('gift_campaign_delivery_mode', [
  'self_claim',
  'auto_credit',
]);

export const giftCampaignStatusEnum = pgEnum('gift_campaign_status', [
  'draft',
  'scheduled',
  'sent',
  'canceled',
]);

export const giftCampaigns = pgTable(
  'gift_campaigns',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    key: text('key').notNull(),
    title: text('title').notNull(),
    amountPaise: integer('amount_paise').notNull(),
    audienceMaxBalancePaise: integer('audience_max_balance_paise'),
    deliveryMode: giftCampaignDeliveryModeEnum('delivery_mode').notNull(),
    claimWindowDays: integer('claim_window_days'),
    creditExpiryDays: integer('credit_expiry_days'),
    scheduledSendAt: timestamp('scheduled_send_at', { withTimezone: true }),
    status: giftCampaignStatusEnum('status').notNull().default('draft'),
    validFrom: timestamp('valid_from', { withTimezone: true }),
    validUntil: timestamp('valid_until', { withTimezone: true }),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (table) => ({
    keyUnique: uniqueIndex('gift_campaigns_key_unique').on(table.key),
    statusIdx: index('gift_campaigns_status_idx').on(table.status),
  }),
);

export type GiftCampaignRow = typeof giftCampaigns.$inferSelect;
export type NewGiftCampaignRow = typeof giftCampaigns.$inferInsert;

/* -------------------------------------------------------------------------- */
/* coupons — admin-issued discount codes for credit-pack purchases             */
/* -------------------------------------------------------------------------- */

export const couponDiscountTypeEnum = pgEnum('coupon_discount_type', ['percent', 'flat']);

export const coupons = pgTable(
  'coupons',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    code: text('code').notNull(),
    discountType: couponDiscountTypeEnum('discount_type').notNull(),
    /** Percent: 1-100. Flat: paise off the pack price. */
    discountValue: integer('discount_value').notNull(),
    /** Null = unlimited redemptions. */
    maxRedemptions: integer('max_redemptions'),
    redemptionCount: integer('redemption_count').notNull().default(0),
    minAmountPaise: integer('min_amount_paise'),
    active: boolean('active').notNull().default(true),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (table) => ({
    codeUpperUnique: uniqueIndex('coupons_code_upper_unique').on(sql`upper(${table.code})`),
  }),
);

export type CouponRow = typeof coupons.$inferSelect;
export type NewCouponRow = typeof coupons.$inferInsert;

/* -------------------------------------------------------------------------- */
/* orders — credit-pack purchases (gateway integration pending, see billing)   */
/* -------------------------------------------------------------------------- */

// 'refund_pending'/'refunded' are new: previously there was no refund path for a top-up order at
// all (every refund anywhere else in the codebase is a wallet-credit side effect with no queryable
// state of its own — see refundOrder in billing.repo.ts). 'pending'/'paid'/'failed'/'cancelled' are
// unchanged; 'paid' already doubles as "completed" since confirmOrderAndGrantCredits grants credits
// in the same atomic transition as marking paid, so there is no separate PAID-vs-COMPLETED gap to
// close here the way there is for report generation.
export const orderStatusEnum = pgEnum('order_status', [
  'pending',
  'paid',
  'failed',
  'cancelled',
  'refund_pending',
  'refunded',
]);

export const orders = pgTable(
  'orders',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Matches an id in billing.service.ts's CREDIT_PACKS — not its own table since the catalog is small/static. */
    packId: text('pack_id').notNull(),
    amountPaise: integer('amount_paise').notNull(),
    discountPaise: integer('discount_paise').notNull().default(0),
    finalAmountPaise: integer('final_amount_paise').notNull(),
    currency: text('currency').notNull().default('INR'),
    couponId: uuid('coupon_id').references(() => coupons.id),
    couponCode: text('coupon_code'),
    status: orderStatusEnum('status').notNull().default('pending'),
    /** 'mock' until a real gateway (Razorpay/Stripe) is wired up. */
    gatewayProvider: text('gateway_provider').notNull().default('mock'),
    gatewayOrderId: text('gateway_order_id'),
    gatewayPaymentId: text('gateway_payment_id'),
    /** Short opaque support-facing id (e.g. "AR-7F3K9Q2M"), generated on insert — the uuid PK
     * is not something a support agent or a user can read back over chat/email. */
    reference: text('reference')
      .notNull()
      .$defaultFn(() => generateOrderReference()),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    /** Set together with `status: 'paid'` — the moment credits were granted. */
    paidAt: timestamp('paid_at', { withTimezone: true }),
    /** Set the moment the gateway signature check passes, inside the same transaction as
     * `paidAt`/`status`. Kept distinct from `paidAt` so "we cryptographically verified this
     * payment" is separately auditable from "we marked it paid" even though today they always
     * happen together — see confirmOrderAndGrantCredits. */
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
  },
  (table) => ({
    userIdx: index('orders_user_id_idx').on(table.userId),
    referenceIdx: uniqueIndex('orders_reference_idx').on(table.reference),
  }),
);

export type OrderRow = typeof orders.$inferSelect;
export type NewOrderRow = typeof orders.$inferInsert;

export type WalletTransactionRow = typeof walletTransactions.$inferSelect;
export type NewWalletTransactionRow = typeof walletTransactions.$inferInsert;

/* -------------------------------------------------------------------------- */
/* prediction_feedback — user feedback on predictions                          */
/* -------------------------------------------------------------------------- */

export const predictionFeedback = pgTable(
  'prediction_feedback',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    predictionId: text('prediction_id'),
    rating: integer('rating'),
    helpful: boolean('helpful'),
    comment: text('comment'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (table) => ({
    userIdx: index('prediction_feedback_user_id_idx').on(table.userId),
  }),
);

/* -------------------------------------------------------------------------- */
/* ai_usage — LLM token/cost tracking                                          */
/* -------------------------------------------------------------------------- */

export const aiUsage = pgTable(
  'ai_usage',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    agent: text('agent').notNull(),
    model: text('model').notNull(),
    // Which key tier served this call: 'free' or 'paid'. Cost reporting needs
    // it because free-tier calls cost ₹0 — without it, every rupee figure on
    // the admin dashboard is a fiction that charges list price for calls that
    // were never billed. Nullable for rows written before the paid reserve
    // existed, which cannot be attributed retroactively.
    tier: text('tier'),
    tokensIn: integer('tokens_in').notNull().default(0),
    tokensOut: integer('tokens_out').notNull().default(0),
    durationMs: integer('duration_ms'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (table) => ({
    userIdx: index('ai_usage_user_id_idx').on(table.userId),
    // Every cost query filters on a date range; without this the table is
    // sequentially scanned, and it only grows.
    createdAtIdx: index('ai_usage_created_at_idx').on(table.createdAt),
  }),
);

/* -------------------------------------------------------------------------- */
/* precompute_jobs — background job tracking                                    */
/* -------------------------------------------------------------------------- */

export const precomputeJobStatusEnum = pgEnum('precompute_job_status', [
  'pending',
  'running',
  'completed',
  'failed',
]);

export const precomputeJobs = pgTable(
  'precompute_jobs',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    profileId: uuid('profile_id'),
    periodType: text('period_type').notNull(),
    periodKey: text('period_key').notNull(),
    status: precomputeJobStatusEnum('status').notNull().default('pending'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (table) => ({
    userPeriodIdx: index('precompute_jobs_user_period_idx').on(
      table.userId,
      table.periodType,
      table.periodKey,
    ),
  }),
);

/* -------------------------------------------------------------------------- */
/* cron_batch_runs — resumable pagination checkpoint for nightly cron batches  */
/* -------------------------------------------------------------------------- */

export const cronBatchRunStatusEnum = pgEnum('cron_batch_run_status', [
  'running',
  'completed',
  'failed',
]);

export const cronBatchRuns = pgTable(
  'cron_batch_runs',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    jobName: text('job_name').notNull(),
    period: text('period').notNull(),
    forDate: text('for_date').notNull(),
    status: cronBatchRunStatusEnum('status').notNull().default('running'),
    // Cursor into the paginated scan — a users.id value, but stored with no FK:
    // it's just a bookmark, shouldn't cascade on user deletion, and needs no
    // referential integrity.
    lastId: uuid('last_id'),
    processed: integer('processed').notNull().default(0),
    generated: integer('generated').notNull().default(0),
    skipped: integer('skipped').notNull().default(0),
    failed: integer('failed').notNull().default(0),
    error: text('error'),
    startedAt: timestamp('started_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => ({
    jobPeriodDateIdx: uniqueIndex('cron_batch_runs_job_period_date_idx').on(
      table.jobName,
      table.period,
      table.forDate,
    ),
  }),
);

/* -------------------------------------------------------------------------- */
/* kundlis — one precomputed natal kundli per account holder                   */
/* -------------------------------------------------------------------------- */

export const kundliStatusEnum = pgEnum('kundli_status', [
  'pending',
  'generating',
  'ready',
  'failed',
]);

export const kundlis = pgTable(
  'kundlis',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /**
     * Which profile this kundli belongs to. NULL = the primary/self profile
     * (the users row itself); non-null = an additional profile in
     * birth_profiles. See the two partial unique indexes below — Postgres
     * treats NULL as distinct from every other NULL, so a plain composite
     * unique on (userId, birthProfileId) would NOT prevent duplicate primary
     * rows, hence the split.
     */
    birthProfileId: uuid('birth_profile_id').references(() => birthProfiles.id, {
      onDelete: 'cascade',
    }),
    status: kundliStatusEnum('status').notNull().default('pending'),
    /** Resolved ayanamsa actually used for the computation (engine-supported). */
    ayanamsa: text('ayanamsa'),
    /** Resolved house system actually used ('W' | 'P' | 'K' | 'E'). */
    houseSystem: text('house_system'),
    /** CALCULATION_VERSION (astro-engine/version.ts) at generation time — already folded into
     * birthHash below (a version bump invalidates every cached row automatically), stored here
     * too so it's directly queryable without decoding the hash. */
    calculationVersion: text('calculation_version'),
    /** EPHEMERIS_VERSION (astro-engine/version.ts) at generation time — same rationale as
     * calculationVersion above. */
    ephemerisVersion: text('ephemeris_version'),
    /** Resolved lunar node type actually used ('mean' | 'true') — same "record what was
     * actually resolved, not just the raw preference" reasoning as ayanamsa/houseSystem above.
     * Null means the server default was used (see resolveLunarNode). */
    nodeType: text('node_type'),
    /**
     * false when birth time was unknown → a degraded sign-level kundli with no
     * ascendant/houses/dasha. Distinguishes a valid degraded chart from a bug.
     */
    timeKnown: boolean('time_known'),
    /** Hash of the birth inputs this kundli was computed from (staleness/dedupe). */
    birthHash: text('birth_hash'),
    chartData: jsonb('chart_data').$type<Record<string, unknown>>(),
    dashaData: jsonb('dasha_data').$type<Record<string, unknown>>(),
    yogaData: jsonb('yoga_data').$type<Record<string, unknown>>(),
    doshaData: jsonb('dosha_data').$type<Record<string, unknown>>(),
    ashtakavargaData: jsonb('ashtakavarga_data').$type<Record<string, unknown>>(),
    /** Cached translations of yogaData/doshaData's translatable name/description prose by language code — same shape as vastu_plans.translations. */
    translations: jsonb('translations').$type<Record<string, Record<string, unknown>>>(),
    error: text('error'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    generatedAt: timestamp('generated_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (table) => ({
    // One kundli per user for the primary profile (birthProfileId is null) …
    userPrimaryUnique: uniqueIndex('kundlis_user_primary_unique')
      .on(table.userId)
      .where(sql`${table.birthProfileId} is null`),
    // … and one kundli per (user, additional profile) otherwise.
    userProfileUnique: uniqueIndex('kundlis_user_profile_unique')
      .on(table.userId, table.birthProfileId)
      .where(sql`${table.birthProfileId} is not null`),
  }),
);

export type KundliRow = typeof kundlis.$inferSelect;
export type NewKundliRow = typeof kundlis.$inferInsert;

/* -------------------------------------------------------------------------- */
/* daily_horoscopes — one personalized horoscope per user per period           */
/* -------------------------------------------------------------------------- */

export const horoscopePeriodEnum = pgEnum('horoscope_period', [
  'daily',
  'tomorrow',
  'weekly',
  'monthly',
  'yearly',
]);

/**
 * No 'pending' (unlike kundli_status): a horoscope row simply doesn't exist
 * yet for a (user, period, periodKey) that's never been attempted, so row
 * non-existence already carries that meaning — a 'generating' placeholder is
 * only ever inserted the moment generation is actually claimed.
 */
export const horoscopeStatusEnum = pgEnum('horoscope_status', ['generating', 'ready', 'failed']);

/** A short per-month blurb, populated only on `period: 'yearly'` rows. */
export type MonthlyBreakdownEntry = {
  month: number; // 1-12
  monthLabel: string; // e.g. "January"
  summary: string;
  /**
   * One relatable hook line per sub-category (Health/Career/Marriage/Finance/
   * Education) for that month — added 2026-07-06 so the yearly month-by-month
   * view isn't just a single overall paragraph. Optional: older rows generated
   * before this field existed won't have it.
   */
  categoryHooks?: Record<Exclude<Category, 'overall'>, string>;
};

/**
 * Rich structured reading — mirrors the shape the moon-sign forecast cards
 * already use (components/horoscope/types.ts DailyForecastData), so the
 * personalized card can reuse the same Plain-view UI. Populated on every
 * period's rows, including yearly (alongside its monthly breakdown).
 *
 * `categories` (added 2026-07-03) holds independently-rated Health/Career/
 * Marriage plus a derived Overall — see
 * docs/superpowers/specs/2026-07-03-horoscope-category-ratings-design.md.
 * The top-level hook/description/advice/quality/score fields are kept as a
 * mirror of `categories.overall` for backward compatibility with any
 * consumer still reading the old singular shape.
 */
export type StructuredHoroscope = {
  hook: string;
  description: string;
  advice: string;
  quality: 'good' | 'moderate' | 'challenging' | 'avoid';
  score: number; // 1-5
  luckyColor: string;
  luckyNumber: number;
  categories: Record<Category, CategoryReading>;
  /** The day's suggested mantra: a slug from the frontend's shloka library, how many
   *  repetitions, and one line naming the pressure it answers. Optional — rows generated
   *  before this shipped have none, and a reading with no mantra attached is still valid.
   *  Only ever populated for period 'daily'/'tomorrow' (see REMEDY_RULE in llm/horoscope.ts). */
  remedy?: { slug: string; japCount: number; reason: string };
};

export const dailyHoroscopes = pgTable(
  'daily_horoscopes',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** NULL = the primary/self profile; non-null = an additional profile in birth_profiles. */
    birthProfileId: uuid('birth_profile_id').references(() => birthProfiles.id, {
      onDelete: 'cascade',
    }),
    /**
     * The period's start date (in the app's IST timezone): the day itself for
     * 'daily', the Monday for 'weekly', the 1st for 'monthly'/'yearly'. Always
     * a real date so existing date-based sorting/display keeps working.
     */
    forDate: date('for_date').notNull(),
    period: horoscopePeriodEnum('period').notNull().default('daily'),
    /**
     * The cache/lookup key within a period — YYYY-MM-DD (daily/weekly, weekly
     * keyed by its Monday), YYYY-MM (monthly), YYYY (yearly). Paired with
     * `period` as the real identity of a row; `forDate` is derived from it.
     */
    periodKey: text('period_key').notNull(),
    /** The hook line — kept as plain text too for push-notification bodies and as a fallback render. Null while 'generating'. */
    summary: text('summary'),
    /** Only set on `period: 'yearly'` rows — a short blurb per calendar month. */
    monthlyBreakdown: jsonb('monthly_breakdown').$type<MonthlyBreakdownEntry[]>(),
    /** The rich Plain-view fields, populated for every period. */
    structured: jsonb('structured').$type<StructuredHoroscope>(),
    /** Cached translations for this horoscope by language code (e.g., 'hi') */
    translations: jsonb('translations').$type<
      Record<
        string,
        {
          summary?: string;
          monthlyBreakdown?: MonthlyBreakdownEntry[];
          structured?: StructuredHoroscope;
          /** Translated hook/meaning for the current dasha reading — see toHoroscopeDto. */
          dasha?: { hook?: string; meaning?: string };
        }
      >
    >(),
    /** Which model produced it ('stub' until the NVIDIA NIM engine is wired). */
    model: text('model'),
    status: horoscopeStatusEnum('status').notNull(),
    /** Claim token: fences markReady/markFailed against a superseding claim, and is heartbeat-refreshed (via updatedAt) by a live retry-forever run so it isn't mistaken for abandoned. */
    startedAt: timestamp('started_at', { withTimezone: true }),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (table) => ({
    // One horoscope per user per period+key — the upsert conflict target.
    // Split into a primary-profile partial index and a full-profile index
    // (see kundlis above for why: NULL birthProfileId can't be deduped by a
    // plain composite unique).
    userPeriodKeyPrimaryUnique: uniqueIndex('daily_horoscopes_user_period_key_primary_unique')
      .on(table.userId, table.period, table.periodKey)
      .where(sql`${table.birthProfileId} is null`),
    userPeriodKeyProfileUnique: uniqueIndex('daily_horoscopes_user_period_key_profile_unique')
      .on(table.userId, table.period, table.periodKey, table.birthProfileId)
      .where(sql`${table.birthProfileId} is not null`),
  }),
);

export type DailyHoroscopeRow = typeof dailyHoroscopes.$inferSelect;
export type NewDailyHoroscopeRow = typeof dailyHoroscopes.$inferInsert;

/* -------------------------------------------------------------------------- */
/* house_insights — one personalized LLM insight per (user, house 1-12)        */
/* -------------------------------------------------------------------------- */

/** Same generating/ready/failed shape as horoscope status — a row is only
 * inserted the moment generation is actually claimed (see claimHouseInsightGeneration). */
export const houseInsightStatusEnum = pgEnum('house_insight_status', [
  'generating',
  'ready',
  'failed',
]);

export const houseInsights = pgTable(
  'house_insights',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** NULL = the primary/self profile; non-null = an additional profile in birth_profiles. */
    birthProfileId: uuid('birth_profile_id').references(() => birthProfiles.id, {
      onDelete: 'cascade',
    }),
    /** 1-12. */
    house: integer('house').notNull(),
    /** Plain-language personalized reading for this house — what it means for THIS chart, not a generic house description. Null while 'generating'. */
    text: text('text'),
    strengths: jsonb('strengths').$type<string[]>(),
    weaknesses: jsonb('weaknesses').$type<string[]>(),
    /** Cached translations for this insight by language code (e.g., 'hi') — same shape as dailyHoroscopes.translations. */
    translations:
      jsonb('translations').$type<
        Record<string, { text?: string; strengths?: string[]; weaknesses?: string[] }>
      >(),
    model: text('model'),
    status: houseInsightStatusEnum('status').notNull(),
    /** Claim token, same fencing pattern as daily_horoscopes.startedAt. */
    startedAt: timestamp('started_at', { withTimezone: true }),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (table) => ({
    userHousePrimaryUnique: uniqueIndex('house_insights_user_house_primary_unique')
      .on(table.userId, table.house)
      .where(sql`${table.birthProfileId} is null`),
    userHouseProfileUnique: uniqueIndex('house_insights_user_house_profile_unique')
      .on(table.userId, table.house, table.birthProfileId)
      .where(sql`${table.birthProfileId} is not null`),
  }),
);

export type HouseInsightRow = typeof houseInsights.$inferSelect;
export type NewHouseInsightRow = typeof houseInsights.$inferInsert;

export const gemstoneRecommendationStatusEnum = pgEnum('gemstone_recommendation_status', [
  'generating',
  'ready',
  'failed',
]);

/**
 * One personalized gemstone report per user — a single row (whole report, all
 * 9 planets, unlocked in one go). Generated lazily the first time the unlocked
 * report is viewed and cached forever after (the natal chart never changes),
 * same lifecycle as house_insights. The deterministic gem facts + curated
 * care notes live in code (astro-engine/gemstones.ts); only the personalized
 * `intro` and per-gem narrative are model-generated and stored here.
 */
export const gemstoneRecommendations = pgTable(
  'gemstone_recommendations',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** NULL = the primary/self profile; non-null = an additional profile in birth_profiles. */
    birthProfileId: uuid('birth_profile_id').references(() => birthProfiles.id, {
      onDelete: 'cascade',
    }),
    /** The full computed report (deterministic gem facts + strength + AI intro/notes). Null while 'generating'. */
    analysis: jsonb('analysis').$type<Record<string, unknown>>(),
    /** Cached translations of the AI-authored fields by language code — same shape as vastu_plans.translations. */
    translations: jsonb('translations').$type<Record<string, Record<string, unknown>>>(),
    model: text('model'),
    status: gemstoneRecommendationStatusEnum('status').notNull(),
    /** Claim token, same fencing pattern as house_insights.startedAt. */
    startedAt: timestamp('started_at', { withTimezone: true }),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (table) => ({
    userPrimaryUnique: uniqueIndex('gemstone_recommendations_user_primary_unique')
      .on(table.userId)
      .where(sql`${table.birthProfileId} is null`),
    userProfileUnique: uniqueIndex('gemstone_recommendations_user_profile_unique')
      .on(table.userId, table.birthProfileId)
      .where(sql`${table.birthProfileId} is not null`),
  }),
);

export type GemstoneRecommendationRow = typeof gemstoneRecommendations.$inferSelect;
export type NewGemstoneRecommendationRow = typeof gemstoneRecommendations.$inferInsert;

export const remedyInsightStatusEnum = pgEnum('remedy_insight_status', [
  'generating',
  'ready',
  'failed',
]);

/**
 * The plain-language half of the Lal Kitab remedies page — one row per
 * (user, birth profile), same lifecycle as gemstone_recommendations and
 * house_insights: generated lazily the first time the page is opened and
 * cached forever after, because the natal chart it explains never changes.
 *
 * Only the model-written prose lives here. Every deterministic fact the page
 * shows (the 108-combination remedy/totka lists, Pakka Ghar, blind planets,
 * karmic debts, and the whole annual rotation) is recomputed on each request
 * in astro.service.ts, so a correction to the engine or the remedy database
 * reaches already-cached users with no backfill.
 *
 * The annual rotation is deliberately NOT explained here: it changes on the
 * reader's birthday, and caching prose about it would need invalidation this
 * table otherwise never requires.
 */
export const remedyInsights = pgTable(
  'remedy_insights',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** NULL = the primary/self profile; non-null = an additional profile in birth_profiles. */
    birthProfileId: uuid('birth_profile_id').references(() => birthProfiles.id, {
      onDelete: 'cascade',
    }),
    /** { intro, planets: { [planet]: prose }, debts: { [debtType]: prose } }. Null while 'generating'. */
    analysis: jsonb('analysis').$type<Record<string, unknown>>(),
    /** Cached translations of the AI-authored fields by language code — same shape as gemstone_recommendations.translations. */
    translations: jsonb('translations').$type<Record<string, Record<string, unknown>>>(),
    model: text('model'),
    status: remedyInsightStatusEnum('status').notNull(),
    /** Claim token, same fencing pattern as gemstone_recommendations.startedAt. */
    startedAt: timestamp('started_at', { withTimezone: true }),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (table) => ({
    userPrimaryUnique: uniqueIndex('remedy_insights_user_primary_unique')
      .on(table.userId)
      .where(sql`${table.birthProfileId} is null`),
    userProfileUnique: uniqueIndex('remedy_insights_user_profile_unique')
      .on(table.userId, table.birthProfileId)
      .where(sql`${table.birthProfileId} is not null`),
  }),
);

export type RemedyInsightRow = typeof remedyInsights.$inferSelect;
export type NewRemedyInsightRow = typeof remedyInsights.$inferInsert;

/* -------------------------------------------------------------------------- */
/* panchang_cache — one row per (date, reference point), shared by all users   */
/* -------------------------------------------------------------------------- */

/**
 * Panchang depends only on date + location, never on the requesting user, so
 * it's cached once per (date, refKey) and reused for everyone hitting that
 * reference point on that day — not per-user like daily_horoscopes.
 * `refKey` is one of the named cities in astro-tools/panchang-reference-points.ts
 * for cron-warmed rows, or a rounded "lat,lon" string (see
 * roundCoordToLocationKey) for an ad-hoc coordinate a user's geolocation
 * resolved to (still worth caching — same rounded spot, same day, many users).
 * Plain `text`, not an enum — arbitrary rounded-coordinate keys are expected.
 */
export const panchangCache = pgTable(
  'panchang_cache',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    forDate: date('for_date').notNull(),
    refKey: text('ref_key').notNull(),
    lat: doublePrecision('lat').notNull(),
    lon: doublePrecision('lon').notNull(),
    data: jsonb('data').notNull().$type<PanchangData>(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (table) => ({
    dateRefUnique: uniqueIndex('panchang_cache_date_ref_unique').on(table.forDate, table.refKey),
  }),
);

export type PanchangCacheRow = typeof panchangCache.$inferSelect;
export type NewPanchangCacheRow = typeof panchangCache.$inferInsert;

/* -------------------------------------------------------------------------- */
/* purchase_plans — Vedic timing analysis for major purchases                  */
/* -------------------------------------------------------------------------- */

export const purchasePlanCategoryEnum = pgEnum('purchase_plan_category', [
  'vehicle',
  'home',
  'commercial',
  'other',
]);

export const purchasePlanStatusEnum = pgEnum('purchase_plan_status', [
  'pending',
  'processing',
  'done',
  'error',
]);

export const purchasePlans = pgTable(
  'purchase_plans',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    chartId: uuid('chart_id').references(() => kundlis.id, { onDelete: 'set null' }),
    category: purchasePlanCategoryEnum('category').notNull(),
    metadata: jsonb('metadata').notNull().default({}).$type<Record<string, string>>(),
    costBracket: text('cost_bracket'),
    bookingDate: date('booking_date'),
    deliveryDate: date('delivery_date'),
    resolvedBookingDate: date('resolved_booking_date').notNull(),
    resolvedDeliveryDate: date('resolved_delivery_date').notNull(),
    panchangDate: date('panchang_date').notNull(),
    language: text('language').notNull().default('en'),
    status: purchasePlanStatusEnum('status').notNull().default('pending'),
    analysis: jsonb('analysis').$type<Record<string, unknown>>(),
    translations: jsonb('translations').$type<Record<string, Record<string, unknown>>>(),
    errorMessage: text('error_message'),
    /** Stamped by markProcessing; the stale-generating reaper (purchase-plan.service.ts's
     * reapStaleProcessingPlans) uses this to find rows abandoned mid-run — this feature is free
     * (no wallet charge), so the reaper only needs to unstick the row and free up the caller's
     * DAILY_PLAN_LIMIT slot, not refund anything. */
    startedAt: timestamp('started_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => ({
    userCreatedIdx: index('purchase_plans_user_created_idx').on(table.userId, table.createdAt),
    statusIdx: index('purchase_plans_status_idx').on(table.status),
  }),
);

export type PurchasePlanRow = typeof purchasePlans.$inferSelect;
export type NewPurchasePlanRow = typeof purchasePlans.$inferInsert;

/* -------------------------------------------------------------------------- */
/* vastu_plans — saved Vastu floor plans + their AI remedy analyses           */
/* -------------------------------------------------------------------------- */

export const vastuPlanStatusEnum = pgEnum('vastu_plan_status', [
  'pending',
  'processing',
  'done',
  'error',
]);

export const vastuPlans = pgTable(
  'vastu_plans',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** null = primary profile, matching every other profile-scoped table's convention. */
    birthProfileId: uuid('birth_profile_id').references(() => birthProfiles.id, {
      onDelete: 'cascade',
    }),
    /** The full editable CAD plan (rooms/doors/windows/orientation) for reload. */
    layout: jsonb('layout').$type<Record<string, unknown>>(),
    /** room type → occupied direction(s), the rules-engine input. */
    roomLayout: jsonb('room_layout').notNull().$type<Record<string, string[]>>(),
    /** Door/window facings + any free-text notes passed to the AI. */
    roomDetails: jsonb('room_details').notNull().default({}).$type<Record<string, unknown>>(),
    /** Deterministic weighted score (0–100) from the rules engine. */
    overallScore: integer('overall_score'),
    language: text('language').notNull().default('en'),
    status: vastuPlanStatusEnum('status').notNull().default('pending'),
    analysis: jsonb('analysis').$type<Record<string, unknown>>(),
    translations: jsonb('translations').$type<Record<string, Record<string, unknown>>>(),
    errorMessage: text('error_message'),
    /** The amount actually deducted from the wallet for this plan — refund exactly this on
     * failure/reap, never a re-derived price (a feature-flag price change between charge and
     * refund must not change what comes back). Same convention as palm_readings.pricePaidPaise. */
    pricePaidPaise: integer('price_paid_paise'),
    /** Stamped by markProcessing; the stale-generating reaper (vastu.service.ts's
     * reapStaleVastuPlans) uses this to find rows abandoned mid-run. Same fencing pattern as
     * palm_readings.startedAt. */
    startedAt: timestamp('started_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => ({
    userCreatedIdx: index('vastu_plans_user_created_idx').on(table.userId, table.createdAt),
    statusIdx: index('vastu_plans_status_idx').on(table.status),
  }),
);

export type VastuPlanRow = typeof vastuPlans.$inferSelect;
export type NewVastuPlanRow = typeof vastuPlans.$inferInsert;

/* -------------------------------------------------------------------------- */
/* reports — purchased AI-generated reports (one-time + monthly)              */
/* -------------------------------------------------------------------------- */

/**
 * One row per purchased report — either a one-time report (periodMonth null)
 * or a single month of a monthly report (periodMonth = first-of-month). Same
 * generating/ready/failed lifecycle as gemstone_recommendations, claim-fenced
 * the same way (see claimReportRow in reports.repo.ts).
 *
 * `input` carries partner birth details for kundli_milan ONLY — every other
 * report key always has `input: null`. A user can buy kundli_milan repeatedly
 * against different partners, so those rows are deliberately EXCLUDED from
 * the uniqueness constraints below (see the four partial indexes) rather than
 * being deduped like every other report key.
 *
 * NULL handling: Postgres never treats two NULLs as equal within a unique
 * index, so a single composite index across (birthProfileId, periodMonth) —
 * both independently nullable — would fail to dedupe rows where either is
 * NULL. Same problem gemstone_recommendations solves with two partial
 * indexes for its one nullable dimension (birthProfileId); this table has
 * TWO nullable dimensions (birthProfileId, periodMonth) that both matter for
 * uniqueness, so it needs the full 2x2 cross of that same technique: a
 * column is only ever INCLUDED in an index when that index's WHERE clause
 * guarantees it's non-null for every row the index covers (never both
 * include a nullable column AND rely on it being null — that column is
 * simply omitted from that index instead, exactly like
 * gemstone_recommendations_user_primary_unique omits birth_profile_id).
 */
export const reportStatusEnum = pgEnum('report_status', [
  /** Purchased/claimed but not started — waiting for a generation slot. Every new
   * claim lands here; the puller (pumpReportQueue in reports.service.ts) moves it to
   * 'generating' when the process is under REPORT_QUEUE_CONCURRENCY. A failed attempt
   * with retry budget left comes BACK here with next_attempt_at set. Deliberately not
   * exposed to clients — the DTO layer reports it as 'generating' (see publicStatus)
   * so "not started yet" and "in progress" stay one polling state for the app. */
  'queued',
  'generating',
  'ready',
  'failed',
]);

export const reports = pgTable(
  'reports',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** NULL = the primary/self profile; non-null = an additional profile in birth_profiles. */
    birthProfileId: uuid('birth_profile_id').references(() => birthProfiles.id, {
      onDelete: 'cascade',
    }),
    reportKey: text('report_key').notNull(),
    /** First-of-month for monthly reports; the PURCHASE date for a yearly report
     * (REPORT_CATALOGUE's `isYearly` key — its 1-year validity window is `[periodMonth,
     * periodMonth + 1 year)`, always derived at read time, never stored); null for every
     * other one-time report.
     * ponytail: reusing a column named "period_month" to hold a period START (day
     * granularity, not month) is a deliberate shortcut — it gets yearly reports a distinct
     * row + correct same-day dedupe for free from the existing 4 unique indexes below with
     * zero migration. Rename to `period_start` (and the indexes/DTOs that reference it) if a
     * THIRD non-monthly period shape is ever needed and the overload starts reading as a bug
     * rather than a documented convention. */
    periodMonth: date('period_month'),
    // Defaults to 'queued', not 'generating': a row inserted without an explicit
    // status has certainly not started, and defaulting it to 'generating' would
    // strand it forever (nothing runs it, and the stale reaper skips rows with no
    // startedAt). 'queued' makes the fallback self-correcting — the pump picks it up.
    status: reportStatusEnum('status').notNull().default('queued'),
    /** Canonical English structured sections — shape is defined per report type (see
     * ReportGenerator in reports/report-generator.types.ts), not by this table. Null while
     * 'generating'/'failed'. */
    content: jsonb('content').$type<Record<string, unknown>>(),
    /** Cached translations of `content` by language code — same shape convention as every
     * other translate-on-read table in this schema (gemstone_recommendations, vastu_plans). */
    translations: jsonb('translations')
      .notNull()
      .default({})
      .$type<Record<string, Record<string, unknown>>>(),
    /** Partner birth details — kundli_milan only, null for every other report key. */
    input: jsonb('input').$type<Record<string, unknown>>(),
    /** sha256 of `input` (see hashReportInput in reports.repo.ts), null iff `input` is null.
     * Lets partner/compatibility reports dedupe on identical input the same way every other
     * report key dedupes on (birthProfileId, reportKey, periodMonth) — see the two
     * uniqInputHash* indexes below. Without this, a repeated purchase against the same
     * partner details always inserted a fresh row and charged twice. */
    inputHash: text('input_hash'),
    model: text('model'),
    /**
     * Provenance snapshot — frozen at generation time, never re-derived. A purchased report
     * must not silently change if the calculation engine, ayanamsa default, or prompts are
     * updated later: the buyer paid for what the chart said AT THAT TIME. Generation reads
     * chart/dasha/yoga/dosha facts from `chartSnapshot`, not from the live (possibly since-
     * regenerated) `kundlis` row, so a 2026 report renders identically in 2027 after an engine
     * upgrade — and a support question ("why was Mars in the 7th before and the 6th now?") is
     * answerable by diffing this against the CURRENT kundli/version.ts constants.
     */
    chartSnapshot: jsonb('chart_snapshot').$type<Record<string, unknown>>(),
    /** CALCULATION_VERSION (astro-engine/version.ts) at generation time — see chartSnapshot. */
    calculationVersion: text('calculation_version'),
    /** EPHEMERIS_VERSION (astro-engine/version.ts) at generation time — see chartSnapshot. */
    ephemerisVersion: text('ephemeris_version'),
    /** Resolved ayanamsa/house-system/node actually used — same fields kundlis stores, copied
     * here because the user's PREFERENCE (users.preferredAyanamsa etc.) can change after
     * purchase while this report's content must not. */
    ayanamsa: text('ayanamsa'),
    houseSystem: text('house_system'),
    nodeType: text('node_type'),
    /** Bumped whenever the report-generation PROMPT text changes meaningfully for this report
     * key — independent of CALCULATION_VERSION (prompt wording vs. chart math are different
     * axes of "why does this report read differently now"). Unlike calculationVersion this is
     * NOT folded into any cache-invalidation hash — a prompt change should not retroactively
     * invalidate reports users already paid for, only be recorded for provenance/debugging. */
    promptVersion: text('prompt_version'),
    /** Language the report was generated/purchased in — 'en' for the canonical content row;
     * translations of it are cached separately (see `translations` below), this just records
     * what `content.sections` itself was written in, which is always 'en' today but is stored
     * explicitly rather than assumed, since generatorVersion/promptVersion make the row a
     * standalone provenance record. */
    language: text('language'),
    pricePaidPaise: integer('price_paid_paise').notNull(),
    /** True for a free "generate the real report and blur it" preview row (see
     * previewReport in reports.service.ts) — same generator pipeline as a real
     * purchase, billed at 0. Flipped back to false the moment the user actually
     * pays (claimReportRow always writes isPreview on every claim, purchase claims
     * always pass false — see upgradePreviewToPurchased for the ready-row case). */
    isPreview: boolean('is_preview').notNull().default(false),
    /** Claim token, same fencing pattern as gemstone_recommendations.startedAt. */
    startedAt: timestamp('started_at', { withTimezone: true }),
    error: text('error'),
    /** How many times the stale-row reaper (reapStaleReports) has reclaimed and re-fired
     * generation for this row. Bounds automatic retry — a permanently-broken generation
     * (bad chart data, a prompt that always fails) must eventually fail+refund rather than
     * loop forever. NOT incremented by a normal purchase-claim reclaim (only the reaper's
     * automatic retry counts), and reset to 0 by markReportReady on success. */
    generationAttempts: integer('generation_attempts').notNull().default(0),
    /** Backoff gate for a 'queued' row: the puller ignores it until now() passes this.
     * Null means "runnable immediately" — the normal case for a fresh purchase. Only
     * set when a failed attempt is requeued for retry (see requeueReportForRetry). */
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (table) => ({
    userReportKeyIdx: index('reports_user_idx').on(table.userId, table.reportKey),
    // The queue's only read: "oldest runnable queued row". Partial so it stays tiny
    // (a few rows at a time) no matter how large the table grows — this is polled by
    // every generation completion, not just the 5-minute cron.
    queuedIdx: index('reports_queued_idx')
      .on(table.nextAttemptAt, table.createdAt)
      .where(sql`${table.status} = 'queued'`),
    // The 2x2 cross described in the table doc comment above — one-time vs.
    // monthly (periodMonth null/not-null) crossed with primary vs. additional
    // profile (birthProfileId null/not-null), each ALSO gated by
    // `input IS NULL` so kundli_milan's repeat-purchase-per-partner rows are
    // excluded from every one of these four indexes (see NewReportRow docs).
    uniqPrimaryOnetime: uniqueIndex('reports_uniq_primary_onetime')
      .on(table.userId, table.reportKey)
      .where(
        sql`${table.birthProfileId} is null and ${table.periodMonth} is null and ${table.input} is null`,
      ),
    uniqPrimaryMonthly: uniqueIndex('reports_uniq_primary_monthly')
      .on(table.userId, table.reportKey, table.periodMonth)
      .where(
        sql`${table.birthProfileId} is null and ${table.periodMonth} is not null and ${table.input} is null`,
      ),
    uniqProfileOnetime: uniqueIndex('reports_uniq_profile_onetime')
      .on(table.userId, table.birthProfileId, table.reportKey)
      .where(
        sql`${table.birthProfileId} is not null and ${table.periodMonth} is null and ${table.input} is null`,
      ),
    uniqProfileMonthly: uniqueIndex('reports_uniq_profile_monthly')
      .on(table.userId, table.birthProfileId, table.reportKey, table.periodMonth)
      .where(
        sql`${table.birthProfileId} is not null and ${table.periodMonth} is not null and ${table.input} is null`,
      ),
    // Partner/compatibility reports (input IS NOT NULL) previously had no uniqueness at all —
    // every purchase inserted a fresh row, so a repeated purchase against the same partner
    // details could double-charge and double-generate. Same birthProfileId null/not-null split
    // as the four indexes above, and same reasoning: a NULL birthProfileId can't be INCLUDED in
    // a unique index (NULL never equals NULL), so it's omitted here too, with the WHERE clause
    // carrying the null-ness instead. No periodMonth split — no report key is both
    // partner-requiring and monthly today.
    uniqInputHashPrimary: uniqueIndex('reports_uniq_input_hash_primary')
      .on(table.userId, table.reportKey, table.inputHash)
      .where(sql`${table.birthProfileId} is null and ${table.input} is not null`),
    uniqInputHashProfile: uniqueIndex('reports_uniq_input_hash_profile')
      .on(table.userId, table.birthProfileId, table.reportKey, table.inputHash)
      .where(sql`${table.birthProfileId} is not null and ${table.input} is not null`),
  }),
);

export type ReportRow = typeof reports.$inferSelect;
export type NewReportRow = typeof reports.$inferInsert;

/* -------------------------------------------------------------------------- */
/* forecast_translations — caches general moon/sun sign translations          */
/* -------------------------------------------------------------------------- */

export const forecastTranslations = pgTable(
  'forecast_translations',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    /** The date this forecast applies to */
    forDate: date('for_date').notNull(),
    /** The type of sign: 'moon' or 'sun' */
    signType: text('sign_type').notNull(),
    /** The index of the sign (0-11) */
    signIndex: integer('sign_index').notNull(),
    /** The period (e.g. 'daily', 'weekly') */
    period: text('period').notNull().default('daily'),
    /** Language code, e.g. 'hi' */
    language: text('language').notNull(),
    /** The translated JSON data */
    data: jsonb('data').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (table) => ({
    uniqueLookup: uniqueIndex('forecast_translations_lookup_idx').on(
      table.forDate,
      table.signType,
      table.signIndex,
      table.period,
      table.language,
    ),
  }),
);

export type ForecastTranslationRow = typeof forecastTranslations.$inferSelect;
export type NewForecastTranslationRow = typeof forecastTranslations.$inferInsert;

/* -------------------------------------------------------------------------- */
/* chat_sessions — stored AI chat histories                                   */
/* -------------------------------------------------------------------------- */

export const chatSessions = pgTable(
  'chat_sessions',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** NULL = the primary/self profile; non-null = an additional profile in birth_profiles. */
    birthProfileId: uuid('birth_profile_id').references(() => birthProfiles.id, {
      onDelete: 'cascade',
    }),
    title: text('title').notNull().default('New Chat'),
    // Encrypted at rest (full free-text transcript) — text, not jsonb; the
    // repo layer (chat-sessions.repo.ts) serializes/encrypts on write and
    // decrypts/parses on read, so callers still see a ChatHistoryTurn[].
    history: text('history').notNull().default('[]'),
    summary: text('summary'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    /**
     * User-facing "delete" is a soft delete: set here, hidden from every read
     * immediately, hard-purged by cron 7 days later (see
     * purgeOldDeletedChatSessions in chat-sessions.repo.ts). user_facts has no
     * FK to this table, so deleting a session never touches extracted facts.
     */
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => ({
    userIdx: index('chat_sessions_user_id_idx').on(table.userId),
    deletedAtIdx: index('chat_sessions_deleted_at_idx')
      .on(table.deletedAt)
      .where(sql`${table.deletedAt} is not null`),
  }),
);

export type ChatSessionRow = typeof chatSessions.$inferSelect;
export type NewChatSessionRow = typeof chatSessions.$inferInsert;

/* -------------------------------------------------------------------------- */
/* feedback_counters — simple up/down counters for AI chat replies             */
/* -------------------------------------------------------------------------- */

export const feedbackCounters = pgTable('feedback_counters', {
  metric: text('metric').primaryKey(),
  count: integer('count').notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .default(sql`now()`),
});

export type FeedbackCounterRow = typeof feedbackCounters.$inferSelect;
export type NewFeedbackCounterRow = typeof feedbackCounters.$inferInsert;

/* -------------------------------------------------------------------------- */
/* chat_feedback_reports — saved Q&A for thumbs-down chat replies              */
/* -------------------------------------------------------------------------- */

export const chatFeedbackReports = pgTable(
  'chat_feedback_reports',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    sessionId: uuid('session_id'),
    question: text('question').notNull(),
    answer: text('answer').notNull(),
    locale: text('locale'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (table) => ({
    userIdx: index('chat_feedback_reports_user_id_idx').on(table.userId),
  }),
);

export type ChatFeedbackReportRow = typeof chatFeedbackReports.$inferSelect;
export type NewChatFeedbackReportRow = typeof chatFeedbackReports.$inferInsert;

/* -------------------------------------------------------------------------- */
/* chat_feedback_votes — every thumbs up/down, attributed to the voting user  */
/* -------------------------------------------------------------------------- */

export const chatFeedbackVotes = pgTable(
  'chat_feedback_votes',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    vote: text('vote').notNull(),
    sessionId: uuid('session_id'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (table) => ({
    userIdx: index('chat_feedback_votes_user_id_idx').on(table.userId),
  }),
);

export type ChatFeedbackVoteRow = typeof chatFeedbackVotes.$inferSelect;
export type NewChatFeedbackVoteRow = typeof chatFeedbackVotes.$inferInsert;

/* -------------------------------------------------------------------------- */
/* user_facts — durable personal facts extracted from AI chat conversations    */
/* -------------------------------------------------------------------------- */

export const userFacts = pgTable(
  'user_facts',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** NULL = the primary/self profile; non-null = an additional profile in birth_profiles. */
    birthProfileId: uuid('birth_profile_id').references(() => birthProfiles.id, {
      onDelete: 'cascade',
    }),
    fact: text('fact').notNull(),
    category: text('category'),
    /** Encrypted like `fact`. A natural, non-intrusive question worth asking again once this topic recurs (e.g. "Did the new job start yet?") — null when the fact needs no follow-up. */
    followUpQuestion: text('follow_up_question'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (table) => ({
    userIdx: index('user_facts_user_id_idx').on(table.userId),
  }),
);

export type UserFactRow = typeof userFacts.$inferSelect;
export type NewUserFactRow = typeof userFacts.$inferInsert;

/* -------------------------------------------------------------------------- */
/* telegram_admin_audit_log — who ran what via the Telegram admin bot          */
/* -------------------------------------------------------------------------- */

export const telegramAdminAuditLog = pgTable(
  'telegram_admin_audit_log',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    chatId: text('chat_id').notNull(),
    tier: text('tier').notNull(), // 'admin' | 'readonly'
    command: text('command').notNull(),
    args: text('args'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (table) => ({
    createdAtIdx: index('telegram_admin_audit_log_created_at_idx').on(table.createdAt),
  }),
);

export type TelegramAdminAuditLogRow = typeof telegramAdminAuditLog.$inferSelect;
export type NewTelegramAdminAuditLogRow = typeof telegramAdminAuditLog.$inferInsert;

/* -------------------------------------------------------------------------- */
/* notifications — push / bell notifications                                   */
/* -------------------------------------------------------------------------- */

export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    body: text('body').notNull(),
    type: text('type').notNull(),
    /** Where tapping this notification in the Bell sheet should navigate to (e.g.
     * '/reports/abc123'). Column has existed on the live table since migration 011 — this was
     * simply never modeled in the Drizzle schema before, so the app couldn't read/write it. */
    link: text('link'),
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (table) => ({
    userIdx: index('notifications_user_id_idx').on(table.userId),
    // Supports the transit-alert dormancy throttle, which asks "has this user
    // had a notification of this type in the last 15 days" for every candidate
    // recipient on every send.
    userTypeCreatedIdx: index('notifications_user_type_created_idx').on(
      table.userId,
      table.type,
      table.createdAt,
    ),
  }),
);

export type NotificationRow = typeof notifications.$inferSelect;
export type NewNotificationRow = typeof notifications.$inferInsert;

/* -------------------------------------------------------------------------- */
/* transit_events — computed planetary ingress / station calendar              */
/* -------------------------------------------------------------------------- */

export const transitEventTypeEnum = pgEnum('transit_event_type', [
  'ingress',
  'retrograde',
  'direct',
]);

export const transitEventStatusEnum = pgEnum('transit_event_status', [
  /** Detected and stored, but not yet chosen for delivery. */
  'detected',
  /** Chosen for delivery and copy has been generated. */
  'drafted',
  /** Push has gone out. */
  'sent',
  /** Deliberately not pushed — see skipReason (e.g. lost a collision). */
  'skipped',
]);

/**
 * The app's own transit calendar, computed from the bundled Swiss Ephemeris by
 * findTransitEvents() — never scraped. Published transit calendars are usually
 * tropical or use a different ayanamsa; ours is Lahiri sidereal, so an external
 * date would contradict the Kundli and Sade Sati pages by days.
 *
 * Every detected event is stored, including ones that will never be pushed —
 * they are still true, and still useful to show in-app.
 */
export const transitEvents = pgTable(
  'transit_events',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    planet: text('planet').notNull(),
    eventType: transitEventTypeEnum('event_type').notNull(),
    /** Sign being left (ingress) or stood in (station). */
    fromSign: text('from_sign').notNull(),
    /** Sign being entered. Null for stations — nothing is entered. */
    toSign: text('to_sign'),
    /** The moment the event completes, accurate to ~5 seconds. */
    exactAt: timestamp('exact_at', { withTimezone: true }).notNull(),
    /** IST calendar date of exactAt (YYYY-MM-DD) — the date the copy talks about. */
    forDate: text('for_date').notNull(),
    /** When the pre-alert should be sent: 19:00 IST, two days before forDate. */
    pushAt: timestamp('push_at', { withTimezone: true }).notNull(),
    /** Collision priority — slow/rare planets outrank fast/frequent ones. */
    weight: integer('weight').notNull().default(0),
    status: transitEventStatusEnum('status').notNull().default('detected'),
    skipReason: text('skip_reason'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (table) => ({
    // Re-running detection over an already-scanned window must be a no-op, not
    // a duplicate calendar. A planet can only do a given thing once per day.
    planetTypeDateUnique: uniqueIndex('transit_events_planet_type_date_idx').on(
      table.planet,
      table.eventType,
      table.forDate,
    ),
    pushAtIdx: index('transit_events_push_at_idx').on(table.pushAt),
  }),
);

export type TransitEventRow = typeof transitEvents.$inferSelect;
export type NewTransitEventRow = typeof transitEvents.$inferInsert;

/* -------------------------------------------------------------------------- */
/* transit_alert_copy — AI-written push copy per (event, moon sign, language)  */
/* -------------------------------------------------------------------------- */

/**
 * One row per (event × moon sign × language) actually needed — the drafting
 * job asks the database which combinations have live device tokens first, so a
 * language nobody uses is never generated and never paid for.
 *
 * `isFallback` records that generation or validation failed and the static
 * hand-written copy was substituted. That distinction matters: a spike in
 * fallbacks is the signal that the prompt or the model has regressed, and
 * without the flag it would be invisible.
 */
export const transitAlertCopy = pgTable(
  'transit_alert_copy',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    eventId: uuid('event_id')
      .notNull()
      .references(() => transitEvents.id, { onDelete: 'cascade' }),
    /** Natal Moon sign this copy is written for. Null = users with no chart yet. */
    moonSign: text('moon_sign'),
    lang: text('lang').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    isFallback: boolean('is_fallback').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (table) => ({
    // Postgres treats NULLs as distinct, so the no-chart (moonSign IS NULL)
    // variant needs its own partial unique index — exactly the same split the
    // kundlis table uses for its null birthProfileId.
    eventSignLangUnique: uniqueIndex('transit_alert_copy_event_sign_lang_idx')
      .on(table.eventId, table.moonSign, table.lang)
      .where(sql`${table.moonSign} is not null`),
    eventLangNoSignUnique: uniqueIndex('transit_alert_copy_event_lang_nosign_idx')
      .on(table.eventId, table.lang)
      .where(sql`${table.moonSign} is null`),
  }),
);

export type TransitAlertCopyRow = typeof transitAlertCopy.$inferSelect;
export type NewTransitAlertCopyRow = typeof transitAlertCopy.$inferInsert;

/* -------------------------------------------------------------------------- */
/* saturn_phases — each user's current Sade Sati / Dhaiya phase, persisted    */
/* -------------------------------------------------------------------------- */

export const saturnPhaseEnum = pgEnum('saturn_phase', [
  'sade-sati-rising',
  'sade-sati-peak',
  'sade-sati-setting',
  'dhaiya-4th',
  'dhaiya-8th',
  'none',
]);

/**
 * One row per (user, profile) recording the CURRENT Saturn phase from
 * astro-engine/doshas/saturnPhaseTimeline.ts's real-ingress detection
 * (detectRealSadeSati/detectRealDhaiya), not the cheap live-arithmetic
 * estimate in doshas/sadeSati.ts. Upserted by the phase-detection cron; a
 * phase value that differs from the previously stored row is a transition —
 * see modules/cron/saturn-phase-alert.service.ts.
 */
export const saturnPhases = pgTable(
  'saturn_phases',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** NULL = primary/self profile, same convention as kundlis.birthProfileId. */
    birthProfileId: uuid('birth_profile_id').references(() => birthProfiles.id, {
      onDelete: 'cascade',
    }),
    phase: saturnPhaseEnum('phase').notNull(),
    /** The full merged window containing `phase`, if it's an active phase (not 'none'). */
    windowStart: timestamp('window_start', { withTimezone: true }),
    windowEnd: timestamp('window_end', { withTimezone: true }),
    lastCheckedAt: timestamp('last_checked_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (table) => ({
    userPrimaryUnique: uniqueIndex('saturn_phases_user_primary_unique')
      .on(table.userId)
      .where(sql`${table.birthProfileId} is null`),
    userProfileUnique: uniqueIndex('saturn_phases_user_profile_unique')
      .on(table.userId, table.birthProfileId)
      .where(sql`${table.birthProfileId} is not null`),
  }),
);

export type SaturnPhaseRow = typeof saturnPhases.$inferSelect;
export type NewSaturnPhaseRow = typeof saturnPhases.$inferInsert;

/* -------------------------------------------------------------------------- */
/* feature_flags — admin-editable overrides on top of the FEATURE_REGISTRY     */
/* -------------------------------------------------------------------------- */

/**
 * One row per feature key that an admin has EXPLICITLY overridden — a feature
 * with no row here just uses its `FEATURE_REGISTRY` default (see
 * `src/config/features.ts`). Absence of a row is not an error state.
 */
export const featureFlags = pgTable('feature_flags', {
  key: text('key').primaryKey(),
  enabled: boolean('enabled').notNull(),
  pricePaise: integer('price_paise'),
  /** Optional "strikethrough" MRP shown alongside `pricePaise` on the customer
   * report catalogue when a discount is configured (originalPricePaise >
   * pricePaise). Null means "no discount configured" — never fabricated from
   * `pricePaise` or the structural `basePricePaise`. */
  originalPricePaise: integer('original_price_paise'),
  /** Admin-selected model for an AI feature (only meaningful for registry entries that declare
   * `modelOptions`). Null means "use the registry default". Note the row's `enabled` flag is the
   * kill switch for a model key: disabled resolves back to the global GEMINI_MODEL regardless of
   * what is selected here — see modelOf() in features.service.ts. */
  model: text('model'),
  /** Set only on a false→true enabled transition (see admin.service.ts's updateFeature) — a
   * price/model-only edit while already enabled leaves this untouched. Drives the report
   * catalogue's "New" badge (config/reports.ts's computeIsNewReport); null means "never
   * explicitly enabled by an admin", not "enabled since the beginning of time". */
  enabledAt: timestamp('enabled_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .default(sql`now()`),
  updatedBy: text('updated_by'),
});

export type FeatureFlagRow = typeof featureFlags.$inferSelect;
export type NewFeatureFlagRow = typeof featureFlags.$inferInsert;

/* -------------------------------------------------------------------------- */
/* admin_audit_log — append-only record of admin dashboard actions             */
/* -------------------------------------------------------------------------- */

export const adminAuditLog = pgTable(
  'admin_audit_log',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    adminPhone: text('admin_phone').notNull(),
    route: text('route').notNull(),
    params: jsonb('params'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (table) => ({
    createdAtIdx: index('admin_audit_log_created_at_idx').on(table.createdAt),
  }),
);

export type AdminAuditLogRow = typeof adminAuditLog.$inferSelect;
export type NewAdminAuditLogRow = typeof adminAuditLog.$inferInsert;

/* -------------------------------------------------------------------------- */
/* user_groups / user_group_members / feature_flag_group_overrides            */
/*                                                                             */
/* Admin-defined, manually-curated groups of users (e.g. "beta testers"). A   */
/* group can override enabled/disabled for a feature key on top of the       */
/* the feature_flags default — never price, which stays a single global      */
/* value. Conflict rule (enforced in features.service.ts's                   */
/* resolveFeaturesForUser, not here): if a user is in multiple groups with    */
/* conflicting overrides for the same key, DISABLED WINS.                    */
/* -------------------------------------------------------------------------- */

export const userGroups = pgTable(
  'user_groups',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    name: text('name').notNull(),
    description: text('description'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    // Admin phone, matches admin_audit_log's admin_phone convention.
    createdBy: text('created_by'),
  },
  (table) => ({
    nameUnique: uniqueIndex('user_groups_name_unique').on(sql`lower(${table.name})`),
  }),
);

export type UserGroupRow = typeof userGroups.$inferSelect;
export type NewUserGroupRow = typeof userGroups.$inferInsert;

export const userGroupMembers = pgTable(
  'user_group_members',
  {
    groupId: uuid('group_id')
      .notNull()
      .references(() => userGroups.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    addedAt: timestamp('added_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.groupId, table.userId] }),
    // The hot lookup: "which groups is user X in" — see listGroupIdsForUser.
    userIdx: index('user_group_members_user_id_idx').on(table.userId),
  }),
);

export type UserGroupMemberRow = typeof userGroupMembers.$inferSelect;
export type NewUserGroupMemberRow = typeof userGroupMembers.$inferInsert;

export const featureFlagGroupOverrides = pgTable(
  'feature_flag_group_overrides',
  {
    groupId: uuid('group_id')
      .notNull()
      .references(() => userGroups.id, { onDelete: 'cascade' }),
    featureKey: text('feature_key').notNull(),
    enabled: boolean('enabled').notNull(),
    /** Per-group model override for an AI model-picker key (see FeatureDef.modelOptions on
     * config/features.ts) — null means "inherit the global feature_flags.model choice", same
     * inherit-when-null convention `enabled` would use if this row didn't exist at all. Only
     * meaningful when `enabled` is true; a disabled override falls back to the global default
     * model regardless of what's stored here (same kill-switch semantics as feature_flags.model
     * — see modelOf()/modelForUser() in features.service.ts). */
    model: text('model'),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedBy: text('updated_by'),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.groupId, table.featureKey] }),
  }),
);

export type FeatureFlagGroupOverrideRow = typeof featureFlagGroupOverrides.$inferSelect;
export type NewFeatureFlagGroupOverrideRow = typeof featureFlagGroupOverrides.$inferInsert;

/* -------------------------------------------------------------------------- */
/* support_tickets — user-submitted help/support requests                     */
/*                                                                             */
/* `message`/`adminNote` are encrypted at rest (field-level encryption, see   */
/* src/lib/crypto/field-encryption.ts) — the support.repo.ts layer            */
/* transparently encrypts on write and decrypts on read, so every other      */
/* layer of the app (service/routes) sees plain strings, same convention as  */
/* chat-sessions.repo.ts/user-facts.repo.ts.                                 */
/* -------------------------------------------------------------------------- */

export const supportTickets = pgTable(
  'support_tickets',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    // Nullable — a ticket filed from the public /support form (no account)
    // has no userId. contactName/contactEmail are the fallback identity for
    // that case; a DB-level CHECK constraint (0061_public_support_tickets.sql)
    // enforces "one or the other."
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    // Only set when userId is null. Encrypted at rest via field-encryption.ts,
    // same convention as message/adminNote below.
    contactName: text('contact_name'),
    contactEmail: text('contact_email'),
    category: text('category').notNull(),
    message: text('message').notNull(),
    locale: text('locale'),
    // Nullable — an older client build may not send it.
    appVersion: text('app_version'),
    status: text('status').notNull().default('open'),
    adminNote: text('admin_note'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (table) => ({
    userIdx: index('support_tickets_user_id_idx').on(table.userId),
    statusIdx: index('support_tickets_status_idx').on(table.status),
  }),
);

export type SupportTicketRow = typeof supportTickets.$inferSelect;
export type NewSupportTicketRow = typeof supportTickets.$inferInsert;

/* -------------------------------------------------------------------------- */
/* user_feedback — our own in-app star rating + comment                        */
/*                                                                             */
/* Distinct from the Google Play review card the Android shell can launch:     */
/* that API deliberately reports nothing back (not the stars, not whether a    */
/* review happened, not even whether the card was shown), so a Play review can */
/* never land here. This table is only what the user typed into our own sheet. */
/* -------------------------------------------------------------------------- */

export const userFeedback = pgTable(
  'user_feedback',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    rating: integer('rating').notNull(),
    /** Nullable — the comment box is optional, a bare star rating is valid. */
    comment: text('comment'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (table) => ({
    userIdx: index('user_feedback_user_id_idx').on(table.userId),
  }),
);

export type UserFeedbackRow = typeof userFeedback.$inferSelect;
export type NewUserFeedbackRow = typeof userFeedback.$inferInsert;

/* -------------------------------------------------------------------------- */
/* report_ratings — per-report star rating; <3 stars auto-refunds 100% of    */
/* what was paid for that specific report. Distinct from user_feedback       */
/* (once-ever, app-wide) — this is repeatable, one row per (user, report).   */
/* -------------------------------------------------------------------------- */

export const reportRatings = pgTable(
  'report_ratings',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    reportId: uuid('report_id')
      .notNull()
      .references(() => reports.id, { onDelete: 'cascade' }),
    rating: integer('rating').notNull(),
    /** Nullable — the comment box is optional. Encrypted at rest, same convention as user_feedback.comment. */
    comment: text('comment'),
    /** Set only when this rating (< 3 stars) triggered the automatic refund. */
    refundedPaise: integer('refunded_paise'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (table) => ({
    userReportUnique: uniqueIndex('report_ratings_user_report_unique').on(
      table.userId,
      table.reportId,
    ),
    reportIdx: index('report_ratings_report_id_idx').on(table.reportId),
  }),
);

export type ReportRatingRow = typeof reportRatings.$inferSelect;
export type NewReportRatingRow = typeof reportRatings.$inferInsert;

/* -------------------------------------------------------------------------- */
/* palm_readings — Hasta Samudrika palm analysis                              */
/*                                                                             */
/* Facts here come from photographs via async vision AI, not from a chart, so */
/* this deliberately does NOT reuse the `reports` table's ReportGenerator     */
/* contract (that contract's computeScores() is synchronous/pure/no-I/O and   */
/* is re-run on every read — palm observations are the opposite: expensive,   */
/* image-derived, and never recomputed). Instead this mirrors                */
/* gemstone_recommendations (claim/fence via startedAt, translate-on-read     */
/* into `translations`) crossed with reports' charge-then-poll flow.         */
/* -------------------------------------------------------------------------- */

/**
 * 'observed' is the free-teaser state: Stage A (vision measurement) has completed and
 * `observations` + a partial confidence score are populated, but `content` (the paid Stage
 * B/C interpretation) is still null. 'generating' is reused for BOTH the free observation
 * phase and the paid interpretation phase — the claim/fence/reaper logic doesn't care which
 * work is in flight, only that something is; palm.service.ts's runPalmGeneration branches on
 * whether `observations` is already populated to decide which phase to run next.
 */
export const palmReadingStatusEnum = pgEnum('palm_reading_status', [
  'pending',
  'generating',
  'observed',
  'ready',
  'failed',
]);

/** `mountRelief` holds two kinds of entry keyed by hand: `primary`/`secondary` (per-mount 0-1
 * relief scores, read by palm-rules.ts) and `primaryRegions`/`secondaryRegions` (per-mount
 * normalized positions on that hand's photograph, read by the annotated overlay). Kept as
 * siblings in one column so recording them stays a single best-effort write. */
export interface PalmMountRegion {
  cx: number;
  cy: number;
  radius: number;
}

export type PalmMountReliefData = Record<
  string,
  Record<string, number> | Record<string, PalmMountRegion>
>;

export const palmReadings = pgTable(
  'palm_readings',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** NULL = the primary/self profile; non-null = an additional profile in birth_profiles.
     * Present from day one — vastu_plans shipped without this and needed a corrective
     * migration once multi-profile landed. */
    birthProfileId: uuid('birth_profile_id').references(() => birthProfiles.id, {
      onDelete: 'cascade',
    }),
    status: palmReadingStatusEnum('status').notNull().default('pending'),
    /** Right for male, left for female — the classical primary/dominant hand. */
    primaryHand: text('primary_hand').notNull(),
    /** { slot: { path, hash, capturedAt } } for each of the 6 capture slots. Populated as
     * uploads land, so a 'pending' row can have a partial set. */
    frames: jsonb('frames').notNull().default({}).$type<Record<string, unknown>>(),
    /** SHA-256 over the full concatenated frame set. NULL until all required frames are in.
     * Used to dedupe an identical re-upload so the vision call is skipped entirely. */
    framesHash: text('frames_hash'),
    /** Stage A output — pure measurement (lines, mounts, fingers, markings). Never
     * recomputed; this IS the measurement of record for this reading. */
    observations: jsonb('observations').$type<Record<string, unknown>>(),
    /** { primary?: Record<MountKey, number>, secondary?: Record<MountKey, number> } — a
     * deterministic computer-vision cross-check on mount development, computed client-side
     * (MediaPipe hand-landmark detection anchors each mount's pixel region, then a luminance-
     * variance pass scores it, both 0-1 normalized per hand) and uploaded alongside the
     * front-view frames. Optional and best-effort: absent for any hand where landmark
     * detection failed. Used by palm-rules.ts to corroborate or flag disagreement with the
     * vision model's own "flat/normal/prominent" mount rating — never a replacement for it.
     *
     * `<hand>Regions` carries WHERE each mount sits on that hand's front-view photograph
     * (normalized 0-1, from the same landmark detection). The annotated overlay draws its mount
     * dots from these, so they land on the actual hand in the actual framing rather than at
     * fixed anatomical averages. */
    mountRelief: jsonb('mount_relief').$type<PalmMountReliefData>(),
    /** Stage B/C output — canonical English narrative sections. Null while
     * 'pending'/'generating'/'failed'. */
    content: jsonb('content').$type<Record<string, unknown>>(),
    /** Cached translations of `content`, same convention as every other translate-on-read
     * table (reports, gemstone_recommendations, vastu_plans). */
    translations: jsonb('translations')
      .notNull()
      .default({})
      .$type<Record<string, Record<string, unknown>>>(),
    /** Stage-A imageQuality-derived overall confidence, 0-100. */
    confidenceScore: integer('confidence_score'),
    unlocked: boolean('unlocked').notNull().default(false),
    pricePaidPaise: integer('price_paid_paise'),
    model: text('model'),
    /** Claim token, same fencing pattern as gemstone_recommendations.startedAt /
     * reports.startedAt. */
    startedAt: timestamp('started_at', { withTimezone: true }),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (table) => ({
    userIdx: index('palm_readings_user_idx').on(table.userId, table.createdAt),
    // Identical re-upload for the same user -> skip the AI call entirely.
    userFramesHashIdx: index('palm_readings_user_frames_hash_idx').on(
      table.userId,
      table.framesHash,
    ),
  }),
);

export type PalmReadingRow = typeof palmReadings.$inferSelect;
export type NewPalmReadingRow = typeof palmReadings.$inferInsert;

/* -------------------------------------------------------------------------- */
/* voice_sessions — realtime voice (Gemini Live) billing ledger               */
/*                                                                             */
/* This table exists because the audio itself never touches this server. The   */
/* client streams straight to Google over a WebSocket using a short-lived      */
/* ephemeral token the backend mints (see lib/llm/gemini-live-token.ts), which */
/* means there is no request-per-turn to count and no session end this server  */
/* observes. The ONLY thing the backend controls is how many tokens it mints,  */
/* so a row here is the durable record of exactly that: one `minutesCharged`   */
/* increment per token issued, each paired with a ₹20 wallet_transactions      */
/* debit, refusing to mint beyond VOICE_MAX_MINUTES.                           */
/*                                                                             */
/* Deliberately a DB row and not a Redis key, unlike the in-flight locks: this */
/* is the audit trail for money taken from a user, and must survive a Redis    */
/* flush, an eviction or a restart in order to reconcile against the wallet    */
/* ledger.                                                                     */
/* -------------------------------------------------------------------------- */

export const voiceSessions = pgTable(
  'voice_sessions',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** NULL = the primary/self profile; non-null = an additional profile in birth_profiles. */
    birthProfileId: uuid('birth_profile_id').references(() => birthProfiles.id, {
      onDelete: 'cascade',
    }),
    /**
     * Minutes billed so far — incremented once per successfully minted token,
     * and the value the VOICE_MAX_MINUTES ceiling is checked against. Not a
     * measurement of how long the user actually spoke: a minute is charged when
     * it is granted, because whether it was used is only knowable to the client
     * and this number decides what the user pays.
     */
    minutesCharged: integer('minutes_charged').notNull().default(0),
    /**
     * Cleared when the session ends (either the client says so, or the ceiling
     * is reached). A session that is still `true` long after `updatedAt` is one
     * whose client vanished without telling us — harmless, since no further
     * minute can be charged without another mint request.
     */
    active: boolean('active').notNull().default(true),
    /** BCP-47-ish app language the session was opened in, for support/debugging. */
    locale: text('locale'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    endedAt: timestamp('ended_at', { withTimezone: true }),
  },
  (table) => ({
    userIdx: index('voice_sessions_user_idx').on(table.userId, table.createdAt),
  }),
);

export type VoiceSessionRow = typeof voiceSessions.$inferSelect;
export type NewVoiceSessionRow = typeof voiceSessions.$inferInsert;

/* -------------------------------------------------------------------------- */
/* prediction_outcomes — the falsifiability layer                             */
/*                                                                            */
/* Nothing in this system could answer "was that prediction right?".          */
/* `feedbackCounters` is global; the per-user vote log attributes a vote to a  */
/* USER, never to the specific claim. So every accuracy improvement shipped    */
/* unmeasurable. One row per DATED claim — undated character readings are      */
/* deliberately not recorded, because there is nothing to score them against.  */
/* -------------------------------------------------------------------------- */

export const predictionOutcomes = pgTable(
  'prediction_outcomes',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** NULL = the primary/self profile, same convention as reports/kundlis. */
    birthProfileId: uuid('birth_profile_id').references(() => birthProfiles.id, {
      onDelete: 'cascade',
    }),
    /** 'chat' | 'horoscope' | 'report' | 'transit_alert'. */
    surface: text('surface').notNull(),
    /** Originating row id where one exists (report/horoscope/session). */
    sourceId: text('source_id'),
    /** Life area, see dasha-confidence.ts's Domain. */
    domain: text('domain'),
    /** The claim itself, in the words it was made. */
    claim: text('claim').notNull(),
    windowStart: date('window_start'),
    windowEnd: date('window_end'),
    /** HIGH | MEDIUM | LOW, as scored at prediction time. */
    confidence: text('confidence'),
    /** Hash of the grounding facts — NOT the facts, so this never becomes a
     * second copy of personal chart data. Enough to tell "same inputs" apart. */
    factsHash: text('facts_hash'),
    model: text('model'),
    /** Which systems contributed, e.g. {shadbala,double_transit,varshphal}. */
    techniques: text('techniques')
      .array()
      .notNull()
      .default(sql`'{}'`),
    /** -1 wrong, 0 unclear, 1 right. NULL = not yet rated. */
    rating: smallint('rating'),
    /** Whether the predicted event actually occurred, asked after the window closes. */
    happened: boolean('happened'),
    ratedAt: timestamp('rated_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    userIdx: index('prediction_outcomes_user_idx').on(t.userId, t.createdAt),
    surfaceIdx: index('prediction_outcomes_surface_idx').on(t.surface, t.createdAt),
  }),
);

/* -------------------------------------------------------------------------- */
/* user_activity_daily — per-user daily active-seconds, from client heartbeats */
/* -------------------------------------------------------------------------- */

/** One row per user per IST calendar day; secondsActive accumulates via heartbeat upserts. Backs the admin Users table's time-spent columns and the Active Users location breakdown. */
export const userActivityDaily = pgTable(
  'user_activity_daily',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    activityDate: date('activity_date').notNull(),
    secondsActive: integer('seconds_active').notNull().default(0),
  },
  (t) => ({
    userDateUnique: uniqueIndex('user_activity_daily_user_date_unique').on(
      t.userId,
      t.activityDate,
    ),
  }),
);

export type UserActivityDailyRow = typeof userActivityDaily.$inferSelect;
export type NewUserActivityDailyRow = typeof userActivityDaily.$inferInsert;

/* -------------------------------------------------------------------------- */
/* online_user_samples — periodic concurrent-online-count snapshots */
/* -------------------------------------------------------------------------- */

/** One row per 5-min cron tick; onlineCount is a countUsersActiveSince(5min) snapshot. Powers peak-concurrent-users-per-period in the Telegram bot's /stats. */
export const onlineUserSamples = pgTable(
  'online_user_samples',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    sampledAt: timestamp('sampled_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    onlineCount: integer('online_count').notNull(),
  },
  (t) => ({
    sampledAtIdx: index('online_user_samples_sampled_at_idx').on(t.sampledAt),
  }),
);

export type OnlineUserSampleRow = typeof onlineUserSamples.$inferSelect;
export type NewOnlineUserSampleRow = typeof onlineUserSamples.$inferInsert;

export type PredictionOutcomeRow = typeof predictionOutcomes.$inferSelect;
