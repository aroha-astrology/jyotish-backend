/**
 * The canonical server-driven feature registry. This is the single source of
 * truth for every togglable feature/price in the system: the admin dashboard
 * (built on top of this, not here) edits `feature_flags` DB rows keyed by
 * `FeatureDef.key`; the resolver service (`features.service.ts`) merges those
 * overrides on top of the defaults declared below; the enforcement middleware
 * (`middleware/feature.ts`) and the `/v1/me` payload both read the resolved
 * result. Adding a new togglable feature means adding an entry here — nothing
 * else needs to know about it until it's actually wired to a toggle point.
 */

export interface FeatureDef {
  key: string;
  label: string;
  group: 'nav' | 'home' | 'paid' | 'reports' | 'panchang' | 'referral' | 'ai' | 'rewards' | 'chat';
  defaultEnabled: boolean;
  /**
   * For `paid`/`reports` keys this is a PRICE the user is charged. For
   * `referral` keys it is a PAYOUT the user receives (or, for the cap, a
   * ceiling). Both are plain paise amounts resolved the same way — see
   * `priceOf()`/`payoutOf()` in features.service.ts. Any money amount in the
   * app belongs here rather than in a module-level constant: four features
   * previously kept their own and silently ignored the admin panel.
   */
  defaultPricePaise?: number;
  /**
   * Turns this entry into a MODEL PICKER in Admin -> Features: the dashboard renders a dropdown
   * of these options instead of a price box. Only the `ai` group uses it.
   *
   * Semantics of the row's toggle for a model key: `enabled: false` means "ignore the selection,
   * use the global `GEMINI_MODEL`" — i.e. the toggle is the kill switch that puts the feature
   * back on the default model without anyone having to remember which option that was.
   * `enabled: true` means "use the selected model". Resolution lives in `modelOf()`
   * (features.service.ts), which every call site must go through rather than reading a constant
   * — the same discipline `priceOf()` exists to enforce for money.
   */
  modelOptions?: readonly string[];
  /** The option pre-selected when no admin override row exists yet. */
  defaultModel?: string;
}

/**
 * The Gemini models an admin may pick from. Deliberately a short curated list rather than a
 * free-text box: a typo'd model id fails every request for that feature until someone notices,
 * and per-model free-tier quotas differ (see gemini-key-pool.ts) so the set of models that are
 * actually affordable is a decision, not a text field.
 */
export const SELECTABLE_GEMINI_MODELS = [
  'gemini-3.1-flash-lite',
  'gemini-3.1-flash',
  'gemini-3.1-pro',
  'gemini-3.7-flash',
] as const;

export const FEATURE_REGISTRY: readonly FeatureDef[] = [
  // nav
  { key: 'nav.home', label: 'Home tab', group: 'nav', defaultEnabled: true },
  // No longer a bottom-tab slot (moved to a Home card, see home.vastuCard
  // below) — still gates the /vastu page itself directly (FeatureGuard).
  { key: 'nav.vastu', label: 'Vastu page', group: 'nav', defaultEnabled: true },
  { key: 'nav.askAI', label: 'Ask AI tab', group: 'nav', defaultEnabled: true },
  { key: 'nav.horoscope', label: 'Horoscope tab', group: 'nav', defaultEnabled: true },
  // Re-added as a bottom-tab slot (previously reachable only via Home's "See
  // All"/home.reportsSection) — takes the tab-bar position Vastu vacated.
  { key: 'nav.reports', label: 'Reports tab', group: 'nav', defaultEnabled: true },
  { key: 'nav.panchang', label: 'Panchang tab', group: 'nav', defaultEnabled: true },
  // New nav entry ships dark per the standing "new features ship dark" rule
  // (see home.reportsSection/home.palmReading above) — turned on deliberately
  // from Admin -> Features once the /remedies page (karmic profile + Lal
  // Kitab remedy list) has been checked end-to-end. Not a bottom-tab slot
  // (those five are fixed); this gates a ListRow in the profile drawer menu.
  { key: 'nav.remedies', label: 'Remedies menu entry', group: 'nav', defaultEnabled: false },
  // Gates the /shlokas library page (list + per-shloka detail). Split from
  // home.shlokas below the same way nav.vastu is split from home.vastuCard:
  // one key hides the entry point, the other closes the page itself. Ships
  // dark per the standing rule.
  { key: 'nav.shlokas', label: 'Shlokas & Japs page', group: 'nav', defaultEnabled: false },
  // Lets the astrologer ask, once, for the user's income range as a set of
  // tappable options when a money question needs a scale to read against (see
  // lib/chat-income.ts). Off means the prompt never raises income at all —
  // the gate is a single fact line, so flipping this needs no deploy. Ships
  // dark per the standing rule; the answers feed Admin -> User Demographics.
  {
    key: 'chat.incomeAsk',
    label: 'Ask income range in chat',
    group: 'chat',
    defaultEnabled: false,
  },
  // Gates the /gita library page (701 verses, category+need-tag browse, per-
  // verse detail + chant audio). Deliberately a SEPARATE feature from
  // nav.shlokas/home.shlokas above, not folded into that grid — different
  // scale (701 vs 50 verses), Sanskrit-only content shape (no 7-language
  // fields), and its audio streams from gita.routes.ts's own static mount
  // rather than the frontend's public/ bundle. Ships dark per the standing
  // rule.
  { key: 'nav.gita', label: 'Bhagavad Gita page', group: 'nav', defaultEnabled: false },
  // Gates the /rewards page (daily login streak) and its drawer entry.
  // The popup on app-open is gated by the same key on the frontend. Ships
  // dark per the standing rule — the payout amounts below stay enabled
  // (see rewards.dailyBase/rewards.streakBonus) so turning this on doesn't
  // also require re-enabling the two payout keys.
  { key: 'nav.rewards', label: 'Daily reward page', group: 'nav', defaultEnabled: false },
  // home
  { key: 'home.todayReading', label: 'Today Reading card', group: 'home', defaultEnabled: true },
  { key: 'home.kundliCard', label: 'Kundli card', group: 'home', defaultEnabled: true },
  { key: 'home.horoscopeSlider', label: 'Horoscope slider', group: 'home', defaultEnabled: true },
  { key: 'home.matchmaking', label: 'Matchmaking card', group: 'home', defaultEnabled: true },
  // Vastu's new Home entry point now that it's off the bottom tab bar — an
  // existing, already-shipped feature being relocated, not a new one under
  // review, so this defaults ON like matchmaking/kundliCard above.
  { key: 'home.vastuCard', label: 'Vastu card (home)', group: 'home', defaultEnabled: true },
  // New card: defaults OFF per standing rule — turned on deliberately from
  // Admin -> Features once checked end-to-end. Suggests a corrected birth
  // time from dated life events; never applies anything itself.
  {
    key: 'home.birthTimeRectify',
    label: 'Birth-time rectification card (settings)',
    group: 'home',
    defaultEnabled: false,
  },
  // New card: defaults OFF per standing rule — every new card ships dark and
  // is turned on deliberately from the admin panel once ready (see memory
  // feedback-new-cards-default-off-in-admin).
  {
    key: 'home.reportsSection',
    label: 'Reports section (home)',
    group: 'home',
    defaultEnabled: false,
  },
  // New feature, defaults OFF for the same standing reason as
  // home.reportsSection above, AND because this feature handles biometric
  // (palm photograph) data — must be verified end-to-end on the admin's own
  // account via Admin -> Features before being enabled for anyone else.
  {
    key: 'home.palmReading',
    label: 'Palm Reading card (home)',
    group: 'home',
    defaultEnabled: false,
  },
  // Home entry point for the Shlokas & Japs library. Free — deliberately has
  // no `paid.*` counterpart, unlike every other content feature here. Ships
  // dark per the standing rule; turn on from Admin -> Features once the
  // artwork and chant audio have been checked on a real device.
  {
    key: 'home.shlokas',
    label: 'Shlokas & Japs card (home)',
    group: 'home',
    defaultEnabled: false,
  },
  // Gates the AI-picked remedy mantra card inside the daily/tomorrow
  // personalized horoscope detail sheet (see StructuredHoroscope.remedy in
  // db/schema.ts, REMEDY_RULE in lib/llm/horoscope.ts). Also requires
  // nav.shlokas on — the card's CTA links into the shloka library, which is
  // itself dark by default. Free, no paid.* key, same as the library it
  // links into. Ships dark per the standing rule.
  {
    key: 'home.horoscopeRemedy',
    label: 'Remedy mantra in horoscope',
    group: 'home',
    defaultEnabled: false,
  },
  // Home entry point for the Bhagavad Gita library. Free, no paid.* key.
  // Ships dark per the standing rule; turn on from Admin -> Features once the
  // 701-verse render has been spot-checked on a real device.
  {
    key: 'home.gita',
    label: 'Bhagavad Gita card (home)',
    group: 'home',
    defaultEnabled: false,
  },
  // Home entry point for Remedies, replacing its old spot as a ListRow in the
  // profile drawer. Split from nav.remedies the same way home.vastuCard is
  // split from nav.vastu: this key hides the card, nav.remedies still gates
  // the /remedies page itself. Ships dark per the standing rule — turn on
  // from Admin -> Features once the restyled page (image-per-remedy via the
  // shared asset library) has been checked end-to-end.
  {
    key: 'home.remedies',
    label: 'Remedies card (home)',
    group: 'home',
    defaultEnabled: false,
  },
  // paid
  {
    key: 'paid.chat',
    label: 'AI Chat',
    group: 'paid',
    defaultEnabled: true,
    defaultPricePaise: 2000,
  },
  {
    key: 'paid.houseInsight',
    label: 'House Insight (per house)',
    group: 'paid',
    defaultEnabled: true,
    defaultPricePaise: 5000,
  },
  {
    key: 'paid.vastu',
    label: 'Vastu Report',
    group: 'paid',
    defaultEnabled: true,
    defaultPricePaise: 5000,
  },
  {
    key: 'paid.gemstone',
    label: 'Gemstone Report',
    group: 'paid',
    defaultEnabled: true,
    defaultPricePaise: 10000,
  },
  {
    key: 'paid.profileCreation',
    label: 'Extra Birth Profile',
    group: 'paid',
    defaultEnabled: true,
    defaultPricePaise: 20000,
  },
  // Defaults OFF — see home.palmReading above for why. Gate this one deliberately from
  // Admin -> Features once the live vision model and cost-per-reading have been validated.
  {
    key: 'paid.palmReading',
    label: 'Palm Reading',
    group: 'paid',
    defaultEnabled: false,
    defaultPricePaise: 9900,
  },
  // Realtime voice conversation (Gemini Live). Defaults OFF for the standing
  // "new features ship dark" reason, and for two more specific to this one:
  // it records the user's voice (see the separate voice-consent gate in
  // users.voice_consent_at — the flag alone is not enough to reach it), and it
  // runs on a preview model whose free-tier quota is shared with every text
  // feature in the app, so it must be watched against real traffic before it
  // is opened up.
  //
  // UNIQUE PRICING SHAPE: this price is PER MINUTE, not per use. Every other
  // paid.* key here is charged once per unlock/report. Voice is charged once
  // per minute of connected conversation, capped at VOICE_MAX_MINUTES (see
  // modules/voice/voice.service.ts) — so the most a single session can cost is
  // this price × that cap.
  {
    key: 'paid.voiceChat',
    label: 'Voice Chat (realtime, per minute)',
    group: 'paid',
    defaultEnabled: false,
    defaultPricePaise: 2000,
  },
  // reports (one-time)
  {
    key: 'reports.marriage',
    label: 'Marriage Report',
    group: 'reports',
    defaultEnabled: false,
    defaultPricePaise: 9900,
  },
  {
    key: 'reports.past_life',
    label: 'Past Life Report',
    group: 'reports',
    defaultEnabled: false,
    defaultPricePaise: 2500,
  },
  {
    key: 'reports.kundli_milan',
    label: 'Kundli Milan Report',
    group: 'reports',
    defaultEnabled: false,
    defaultPricePaise: 9900,
  },
  {
    key: 'reports.true_love',
    label: 'True Love Report',
    group: 'reports',
    defaultEnabled: false,
    defaultPricePaise: 9900,
  },
  {
    key: 'reports.wealth',
    label: 'Wealth Report',
    group: 'reports',
    defaultEnabled: false,
    defaultPricePaise: 9900,
  },
  {
    key: 'reports.baby_name',
    label: 'Baby Name Report',
    group: 'reports',
    defaultEnabled: false,
    defaultPricePaise: 9900,
  },
  // reports (monthly — price is per-month base; bundle math lives elsewhere)
  {
    key: 'reports.health_monthly',
    label: 'Health Report (Monthly)',
    group: 'reports',
    defaultEnabled: false,
    defaultPricePaise: 2500,
  },
  {
    key: 'reports.career_monthly',
    label: 'Career Report (Monthly)',
    group: 'reports',
    defaultEnabled: false,
    defaultPricePaise: 2500,
  },
  {
    key: 'reports.finance_monthly',
    label: 'Finance Report (Monthly)',
    group: 'reports',
    defaultEnabled: false,
    defaultPricePaise: 2500,
  },
  {
    key: 'reports.relationship_monthly',
    label: 'Relationship Report (Monthly)',
    group: 'reports',
    defaultEnabled: false,
    defaultPricePaise: 2500,
  },
  // Retired (defaultEnabled flipped to false): kundli_milan's sections 6-7 ("Health, Wealth &
  // Career Compatibility" / "Children & Family Harmony Timing") already cover the same 8
  // life-area synastry read as this report — see kundli-milan.ts's own RISK_GROUNDING_RULE
  // doc comment, which says so explicitly ("the same synastry read the pricier Compatibility
  // Match Report uses"). Two ₹50-₹99 products doing the same job was confusing, not
  // complementary, so kundli_milan keeps the full read and this one goes dark. Existing
  // purchased match_report rows stay fully readable (the report detail route doesn't gate on
  // this flag) — this only turns off NEW purchases, both in the Reports catalogue (renders as
  // "Coming Soon" — see ReportCard.tsx's comingSoon prop) and on the dedicated /compatibility
  // page (see its own matchReportUnavailable gate). Generator/prompt code (match-report.*)
  // is deliberately left in place, not deleted — kundli_milan's own sections 6-7 read
  // match-risks.ts directly. NOTE: this default only takes effect where no admin `feature_flags`
  // DB override already exists (DB row wins over this default — see resolveFeaturesForUser's
  // doc comment) — if this key was ever explicitly turned on via the admin panel, that override
  // needs flipping there too after deploy.
  {
    key: 'reports.match_report',
    label: 'Compatibility Match Report',
    group: 'reports',
    defaultEnabled: false,
    defaultPricePaise: 5000,
  },
  // Both have a fully registered generator (real LLM narrative, full i18n) --
  // switched on 2026-07-31 at the user's explicit request, unlike the other
  // reports.* keys above which still ship dark pending a deliberate decision.
  {
    key: 'reports.numerology',
    label: 'Numerology Report',
    group: 'reports',
    defaultEnabled: true,
    defaultPricePaise: 9900,
  },
  {
    key: 'reports.name_change',
    label: 'Name Change Report',
    group: 'reports',
    defaultEnabled: true,
    defaultPricePaise: 4900,
  },
  // New report type, ships dark per the standing rule -- turn on from
  // Admin -> Features once checked end-to-end. Full paid report generator
  // (not the free /remedies page): karmic debts, Pakka Ghar, blind planets,
  // and a Lal Kitab natal remedy per classical planet, narrated by the LLM.
  {
    key: 'reports.remedies',
    label: 'Remedies Report (Lal Kitab)',
    group: 'reports',
    defaultEnabled: false,
    defaultPricePaise: 9900,
  },
  // New report type, ships dark per the standing rule -- turn on from
  // Admin -> Features once checked end-to-end. Requires spouse birth details
  // (requiresPartner, like kundli_milan) and reads both charts' D7 Saptamsha,
  // Beeja/Kshetra sphutas and a dual-school child sequence. Its age-gated
  // children card (35+) is the specific thing to eyeball before enabling.
  {
    key: 'reports.progeny',
    label: 'Progeny Report',
    group: 'reports',
    defaultEnabled: false,
    defaultPricePaise: 9900,
  },
  // panchang
  {
    key: 'panchang.purchasePlan',
    label: 'Planning to Buy card',
    group: 'panchang',
    defaultEnabled: true,
  },
  // referral — payouts OUT to users, not prices charged to them. Registered
  // here (rather than as constants in users.repo.ts, where they used to live)
  // so the admin can tune the referral economics without a deploy, and so the
  // in-app copy can quote the live amount instead of a baked-in number.
  //
  // `enabled: false` on either bonus key pays 0 for that side, which is how the
  // referral programme is switched off — see `payoutOf()` in features.service.
  {
    key: 'referral.referrerBonus',
    label: 'Referral bonus — referrer',
    group: 'referral',
    defaultEnabled: true,
    defaultPricePaise: 10000,
  },
  {
    key: 'referral.refereeBonus',
    label: 'Referral bonus — new user',
    group: 'referral',
    defaultEnabled: true,
    defaultPricePaise: 5000,
  },
  // A ceiling, not a payout: total referral earnings one user may accumulate.
  // `enabled` is ignored for this key.
  {
    key: 'referral.earningsCap',
    label: 'Referral earnings cap (per user)',
    group: 'referral',
    defaultEnabled: true,
    defaultPricePaise: 200000,
  },
  // One-time thank-you credited the first time a user submits an in-app
  // rating. Same reasoning as the referral keys above — an admin-tunable
  // payout, not a hardcoded reward.
  {
    key: 'referral.feedbackReward',
    label: 'Feedback thank-you credit (one-time)',
    group: 'referral',
    defaultEnabled: true,
    defaultPricePaise: 5000,
  },
  // One-time Independence Day 2026 wallet top-up, claimed via a modal on
  // 15 August only (the date window is enforced in the route, not here).
  // `enabled: false` is the campaign kill switch — payoutOf() then returns 0
  // and the claim route responds 410, same mechanism as the referral/feedback
  // keys above.
  {
    key: 'referral.independenceBonus',
    label: 'Independence Day 2026 bonus (one-time)',
    group: 'referral',
    defaultEnabled: true,
    defaultPricePaise: 50000,
  },
  // One-time top-up for wallets under ₹100, claimed via a modal on the
  // campaign's IST date only (window + the balance ceiling are enforced in the
  // route). Same kill switch as the keys above: disabled ⇒ payoutOf() returns 0.
  {
    key: 'referral.topUpBonus',
    label: 'Running-low top-up bonus (one-time)',
    group: 'referral',
    defaultEnabled: true,
    defaultPricePaise: 10000,
  },
  // Daily login streak, day 1 of 7 — see rewards.service.ts for the ladder
  // math (each day after this adds the rewards.dailyStep amount below).
  // `enabled: false` is the payout kill switch, same
  // mechanism as the other referral keys — nav.rewards above is the separate
  // visibility switch.
  {
    key: 'rewards.dailyBase',
    label: 'Daily reward — day 1 amount',
    group: 'rewards',
    defaultEnabled: true,
    defaultPricePaise: 500,
  },
  // Added per day on top of the day-1 base as the ladder climbs (day N pays
  // base + (N-1) x this). A live payout, so it is tunable here rather than a
  // module constant in rewards.service.ts — see admin-price-is-honoured.spec.ts.
  {
    key: 'rewards.dailyStep',
    label: 'Daily reward — per-day step',
    group: 'rewards',
    defaultEnabled: true,
    defaultPricePaise: 100,
  },
  // Extra credit on top of day 7's ladder amount for completing a full
  // 7-day streak (₹11 + this = ₹32 on day 7, ₹77 total across the week).
  {
    key: 'rewards.streakBonus',
    label: 'Daily reward — 7-day streak bonus',
    group: 'rewards',
    defaultEnabled: true,
    defaultPricePaise: 2100,
  },
  // One-time payout for granting OS notification permission. Server-verified:
  // an FCM token cannot exist without the grant, so registering one is the
  // proof — see device-tokens.routes.ts. Ships dark like every new card.
  {
    key: 'rewards.notificationsGrant',
    label: 'Reward — enable notifications',
    group: 'rewards',
    defaultEnabled: false,
    defaultPricePaise: 2500,
  },
  // One-time payout for granting OS location permission. NOT server-verifiable
  // — we deliberately store no coordinates, so this trusts the client's word
  // (POST /v1/rewards/location-granted). Bounded: once per user, wallet credit
  // only. Enable this one knowing that.
  {
    key: 'rewards.locationGrant',
    label: 'Reward — enable location',
    group: 'rewards',
    defaultEnabled: false,
    defaultPricePaise: 2500,
  },
  // ai — model pickers, not toggleable product surface. See `modelOptions` on FeatureDef for
  // what the enabled toggle means on these rows (off = fall back to the global GEMINI_MODEL).
  // Both ship DISABLED so nothing changes until a model is deliberately picked in the
  // dashboard — per-model key-pool quotas have to be confirmed against live keys first.
  {
    key: 'ai.palmVisionModel',
    label: 'Palm — vision model (paid re-scan)',
    group: 'ai',
    defaultEnabled: false,
    modelOptions: SELECTABLE_GEMINI_MODELS,
    defaultModel: 'gemini-3.1-pro',
  },
  {
    key: 'ai.palmInterpretModel',
    label: 'Palm — interpretation model',
    group: 'ai',
    defaultEnabled: false,
    modelOptions: SELECTABLE_GEMINI_MODELS,
    defaultModel: 'gemini-3.1-flash',
  },
  // 2026-08-28: the three highest-traffic/most-reasoning-heavy surfaces
  // (personalized horoscope, AI chat, paid reports) previously had NO model
  // picker at all — every one of them ran on the fixed global GEMINI_MODEL
  // (flash-lite) regardless of admin.model settings, since modelOf()/
  // modelForUser() were only ever wired to the two palm keys above. Ships
  // DISABLED per the standing rule for every key on this page — nothing
  // changes for anyone until a model is deliberately picked.
  {
    key: 'ai.horoscopeModel',
    label: 'Horoscope — daily/weekly/monthly/yearly generation model',
    group: 'ai',
    defaultEnabled: false,
    modelOptions: SELECTABLE_GEMINI_MODELS,
    defaultModel: 'gemini-3.1-flash',
  },
  {
    key: 'ai.chatModel',
    label: 'AI Chat — astrologer reply model',
    group: 'ai',
    defaultEnabled: false,
    modelOptions: SELECTABLE_GEMINI_MODELS,
    defaultModel: 'gemini-3.1-flash',
  },
  {
    key: 'ai.reportModel',
    label: 'Paid Reports — narrative generation model',
    group: 'ai',
    defaultEnabled: false,
    modelOptions: SELECTABLE_GEMINI_MODELS,
    // REPORT_PROFILE already defaults to REASONING_MODEL (config/llm.ts) when
    // this key is off/unset — 'gemini-3.1-pro' here is only the option
    // pre-selected the FIRST time an admin opens this key's dropdown, not a
    // silent behavior change; see modelForReportProfile() in gemini-client.ts.
    defaultModel: 'gemini-3.1-pro',
  },
] as const;

const FEATURE_KEY_SET: ReadonlySet<string> = new Set(FEATURE_REGISTRY.map((f) => f.key));

export function isKnownFeatureKey(key: string): boolean {
  return FEATURE_KEY_SET.has(key);
}
