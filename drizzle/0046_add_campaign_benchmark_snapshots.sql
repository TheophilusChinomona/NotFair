CREATE TABLE IF NOT EXISTS "campaign_benchmark_snapshots" (
  "id" serial PRIMARY KEY NOT NULL,
  "account_id" text NOT NULL,
  "campaign_id" text NOT NULL,
  "snapshot_date" text NOT NULL,
  "ad_network_type" text DEFAULT 'ALL' NOT NULL,
  "device" text DEFAULT 'ALL' NOT NULL,
  "campaign_name" text,
  "campaign_status" text,
  "advertising_channel_type" text,
  "bidding_strategy_type" text,
  "currency_code" text DEFAULT 'UNKNOWN' NOT NULL,
  "time_zone" text,
  "industry_category" text,
  "business_niche" text,
  "business_domain" text,
  "geo_target_count" integer DEFAULT 0 NOT NULL,
  "negative_geo_target_count" integer DEFAULT 0 NOT NULL,
  "language_target_count" integer DEFAULT 0 NOT NULL,
  "geo_target_constants" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "language_constants" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "impressions" integer DEFAULT 0 NOT NULL,
  "clicks" integer DEFAULT 0 NOT NULL,
  "cost_micros" bigint DEFAULT 0 NOT NULL,
  "conversions" double precision DEFAULT 0 NOT NULL,
  "conversions_value" double precision DEFAULT 0 NOT NULL,
  "search_impression_share" double precision,
  "search_top_impression_share" double precision,
  "search_absolute_top_impression_share" double precision,
  "search_budget_lost_impression_share" double precision,
  "search_rank_lost_impression_share" double precision,
  "has_sitelinks" boolean DEFAULT false NOT NULL,
  "sitelink_count" integer DEFAULT 0 NOT NULL,
  "has_callouts" boolean DEFAULT false NOT NULL,
  "callout_count" integer DEFAULT 0 NOT NULL,
  "has_structured_snippets" boolean DEFAULT false NOT NULL,
  "structured_snippet_count" integer DEFAULT 0 NOT NULL,
  "has_image_assets" boolean DEFAULT false NOT NULL,
  "image_asset_count" integer DEFAULT 0 NOT NULL,
  "keyword_broad_impressions" integer DEFAULT 0 NOT NULL,
  "keyword_broad_clicks" integer DEFAULT 0 NOT NULL,
  "keyword_broad_cost_micros" bigint DEFAULT 0 NOT NULL,
  "keyword_broad_conversions" double precision DEFAULT 0 NOT NULL,
  "keyword_broad_conversions_value" double precision DEFAULT 0 NOT NULL,
  "keyword_phrase_impressions" integer DEFAULT 0 NOT NULL,
  "keyword_phrase_clicks" integer DEFAULT 0 NOT NULL,
  "keyword_phrase_cost_micros" bigint DEFAULT 0 NOT NULL,
  "keyword_phrase_conversions" double precision DEFAULT 0 NOT NULL,
  "keyword_phrase_conversions_value" double precision DEFAULT 0 NOT NULL,
  "keyword_exact_impressions" integer DEFAULT 0 NOT NULL,
  "keyword_exact_clicks" integer DEFAULT 0 NOT NULL,
  "keyword_exact_cost_micros" bigint DEFAULT 0 NOT NULL,
  "keyword_exact_conversions" double precision DEFAULT 0 NOT NULL,
  "keyword_exact_conversions_value" double precision DEFAULT 0 NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);

-- Existing installs may already have the table from an older 0046 runner.
ALTER TABLE "campaign_benchmark_snapshots"
  ADD COLUMN IF NOT EXISTS "business_niche" text;

UPDATE "campaign_benchmark_snapshots"
SET "business_niche" = CASE
  WHEN concat_ws(' ', "campaign_name", "business_domain", "industry_category") ~* '\m(pet hotel|dog hotel|pet boarding|dog boarding|cat boarding|boarding|kennel|dog daycare|dog day care|pet daycare|dog resort|pet resort)\M' THEN 'Pet Boarding / Daycare'
  WHEN concat_ws(' ', "campaign_name", "business_domain", "industry_category") ~* '\m(pet groom|dog groom|grooming|groomer|mobile groom)\M' THEN 'Pet Grooming'
  WHEN concat_ws(' ', "campaign_name", "business_domain", "industry_category") ~* '\m(veterinary|veterinarian|vet clinic|animal hospital|pet hospital)\M' THEN 'Veterinary Clinic'
  WHEN concat_ws(' ', "campaign_name", "business_domain", "industry_category") ~* '\m(bookkeeping|book keeper|bookkeeper|quickbooks|accounts payable|accounts receivable|payroll service)\M' THEN 'Bookkeeping'
  WHEN concat_ws(' ', "campaign_name", "business_domain", "industry_category") ~* '\m(accounting|accountant|cpa|tax prep|tax preparation|tax planning|tax service)\M' THEN 'Accounting / Tax'
  WHEN concat_ws(' ', "campaign_name", "business_domain", "industry_category") ~* '\m(plumb|plumber|drain cleaning|water heater)\M' THEN 'Plumbing'
  WHEN concat_ws(' ', "campaign_name", "business_domain", "industry_category") ~* '\m(hvac|heating|air conditioning|furnace|heat pump)\M' THEN 'HVAC'
  WHEN concat_ws(' ', "campaign_name", "business_domain", "industry_category") ~* '\m(roof|roofer|roofing|gutter)\M' THEN 'Roofing'
  WHEN concat_ws(' ', "campaign_name", "business_domain", "industry_category") ~* '\m(dental|dentist|orthodont|invisalign)\M' THEN 'Dental Practice'
  WHEN concat_ws(' ', "campaign_name", "business_domain", "industry_category") ~* '\m(medspa|med spa|botox|filler|aesthetic|laser hair|skin clinic)\M' THEN 'Med Spa / Aesthetics'
  WHEN concat_ws(' ', "campaign_name", "business_domain", "industry_category") ~* '\m(personal injury|injury lawyer|accident lawyer|car accident|truck accident)\M' THEN 'Personal Injury Law'
  WHEN concat_ws(' ', "campaign_name", "business_domain", "industry_category") ~* '\m(divorce|family law|custody|child support)\M' THEN 'Family / Divorce Law'
  WHEN concat_ws(' ', "campaign_name", "business_domain", "industry_category") ~* '\m(saas|software|platform|crm|api|automation|ai agent|llm|mcp)\M' THEN 'SaaS / Business Software'
  WHEN concat_ws(' ', "campaign_name", "business_domain", "industry_category") ~* '\m(real estate|realtor|brokerage|homes for sale|property agent)\M' THEN 'Real Estate Agent / Brokerage'
  WHEN concat_ws(' ', "campaign_name", "business_domain", "industry_category") ~* '\m(property management|apartments|apartment|rental|rentals|leasing)\M' THEN 'Property Management / Apartments'
  WHEN concat_ws(' ', "campaign_name", "business_domain", "industry_category") ~* '\m(restaurant|cafe|pizza|barbecue|bbq|food truck|catering)\M' THEN 'Restaurant / Food Service'
  WHEN concat_ws(' ', "campaign_name", "business_domain", "industry_category") ~* '\m(fitness|gym|personal trainer|pilates|yoga|crossfit)\M' THEN 'Fitness / Gym'
  WHEN concat_ws(' ', "campaign_name", "business_domain", "industry_category") ~* '\m(salon|spa|hair|nails|massage)\M' THEN 'Salon / Spa'
  WHEN "industry_category" IS NOT NULL AND "industry_category" <> 'Other' THEN "industry_category"
  ELSE 'Other'
END
WHERE "business_niche" IS NULL OR "business_niche" = '';

CREATE UNIQUE INDEX IF NOT EXISTS "campaign_benchmark_account_campaign_date_idx"
  ON "campaign_benchmark_snapshots" ("account_id", "campaign_id", "snapshot_date");

DROP INDEX IF EXISTS "campaign_benchmark_peer_slice_idx";
CREATE INDEX IF NOT EXISTS "campaign_benchmark_peer_slice_idx"
  ON "campaign_benchmark_snapshots" ("industry_category", "business_niche", "currency_code", "advertising_channel_type", "snapshot_date");

CREATE INDEX IF NOT EXISTS "campaign_benchmark_channel_date_idx"
  ON "campaign_benchmark_snapshots" ("advertising_channel_type", "snapshot_date");

-- Internal analytics table. Server-side cron/connect backfills write via trusted DB
-- access; do not expose account/campaign benchmark facts through Supabase Data API.
ALTER TABLE "campaign_benchmark_snapshots" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE "campaign_benchmark_snapshots" FROM anon, authenticated;
REVOKE ALL ON SEQUENCE "campaign_benchmark_snapshots_id_seq" FROM anon, authenticated;
