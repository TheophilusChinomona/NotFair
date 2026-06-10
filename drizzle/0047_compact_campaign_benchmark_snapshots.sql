-- Collapse benchmark snapshots from account/campaign/date/network/device rows to
-- one account/campaign/date row. The first MVP collected network × device slices,
-- which made the table materially heavier before the product query shape was
-- proven. Keep ad_network_type/device columns for future compatibility, but store
-- ALL/ALL for now.

BEGIN;

-- Supabase/Postgres URLs may carry a short default timeout. This one-time
-- rewrite can take longer than normal OLTP statements on existing data.
SET LOCAL statement_timeout = 0;

LOCK TABLE "campaign_benchmark_snapshots" IN ACCESS EXCLUSIVE MODE;

CREATE TEMP TABLE "campaign_benchmark_snapshots_rollup" ON COMMIT DROP AS
SELECT
  "account_id",
  "campaign_id",
  "snapshot_date",
  'ALL'::text AS "ad_network_type",
  'ALL'::text AS "device",
  (ARRAY_AGG("campaign_name" ORDER BY "created_at" DESC) FILTER (WHERE "campaign_name" IS NOT NULL))[1] AS "campaign_name",
  (ARRAY_AGG("campaign_status" ORDER BY "created_at" DESC) FILTER (WHERE "campaign_status" IS NOT NULL))[1] AS "campaign_status",
  (ARRAY_AGG("advertising_channel_type" ORDER BY "created_at" DESC) FILTER (WHERE "advertising_channel_type" IS NOT NULL))[1] AS "advertising_channel_type",
  (ARRAY_AGG("bidding_strategy_type" ORDER BY "created_at" DESC) FILTER (WHERE "bidding_strategy_type" IS NOT NULL))[1] AS "bidding_strategy_type",
  COALESCE((ARRAY_AGG("currency_code" ORDER BY "created_at" DESC) FILTER (WHERE "currency_code" IS NOT NULL AND "currency_code" <> 'UNKNOWN'))[1], 'UNKNOWN') AS "currency_code",
  (ARRAY_AGG("time_zone" ORDER BY "created_at" DESC) FILTER (WHERE "time_zone" IS NOT NULL))[1] AS "time_zone",
  (ARRAY_AGG("industry_category" ORDER BY "created_at" DESC) FILTER (WHERE "industry_category" IS NOT NULL))[1] AS "industry_category",
  (ARRAY_AGG("business_niche" ORDER BY "created_at" DESC) FILTER (WHERE "business_niche" IS NOT NULL))[1] AS "business_niche",
  (ARRAY_AGG("business_domain" ORDER BY "created_at" DESC) FILTER (WHERE "business_domain" IS NOT NULL))[1] AS "business_domain",
  MAX("geo_target_count") AS "geo_target_count",
  MAX("negative_geo_target_count") AS "negative_geo_target_count",
  MAX("language_target_count") AS "language_target_count",
  (ARRAY_AGG("geo_target_constants" ORDER BY "created_at" DESC))[1] AS "geo_target_constants",
  (ARRAY_AGG("language_constants" ORDER BY "created_at" DESC))[1] AS "language_constants",
  SUM("impressions")::integer AS "impressions",
  SUM("clicks")::integer AS "clicks",
  SUM("cost_micros")::bigint AS "cost_micros",
  SUM("conversions")::double precision AS "conversions",
  SUM("conversions_value")::double precision AS "conversions_value",
  CASE WHEN SUM("impressions") FILTER (WHERE "search_impression_share" IS NOT NULL) > 0
    THEN SUM("search_impression_share" * "impressions") FILTER (WHERE "search_impression_share" IS NOT NULL)
      / NULLIF(SUM("impressions") FILTER (WHERE "search_impression_share" IS NOT NULL), 0)
    ELSE MAX("search_impression_share")
  END AS "search_impression_share",
  CASE WHEN SUM("impressions") FILTER (WHERE "search_top_impression_share" IS NOT NULL) > 0
    THEN SUM("search_top_impression_share" * "impressions") FILTER (WHERE "search_top_impression_share" IS NOT NULL)
      / NULLIF(SUM("impressions") FILTER (WHERE "search_top_impression_share" IS NOT NULL), 0)
    ELSE MAX("search_top_impression_share")
  END AS "search_top_impression_share",
  CASE WHEN SUM("impressions") FILTER (WHERE "search_absolute_top_impression_share" IS NOT NULL) > 0
    THEN SUM("search_absolute_top_impression_share" * "impressions") FILTER (WHERE "search_absolute_top_impression_share" IS NOT NULL)
      / NULLIF(SUM("impressions") FILTER (WHERE "search_absolute_top_impression_share" IS NOT NULL), 0)
    ELSE MAX("search_absolute_top_impression_share")
  END AS "search_absolute_top_impression_share",
  CASE WHEN SUM("impressions") FILTER (WHERE "search_budget_lost_impression_share" IS NOT NULL) > 0
    THEN SUM("search_budget_lost_impression_share" * "impressions") FILTER (WHERE "search_budget_lost_impression_share" IS NOT NULL)
      / NULLIF(SUM("impressions") FILTER (WHERE "search_budget_lost_impression_share" IS NOT NULL), 0)
    ELSE MAX("search_budget_lost_impression_share")
  END AS "search_budget_lost_impression_share",
  CASE WHEN SUM("impressions") FILTER (WHERE "search_rank_lost_impression_share" IS NOT NULL) > 0
    THEN SUM("search_rank_lost_impression_share" * "impressions") FILTER (WHERE "search_rank_lost_impression_share" IS NOT NULL)
      / NULLIF(SUM("impressions") FILTER (WHERE "search_rank_lost_impression_share" IS NOT NULL), 0)
    ELSE MAX("search_rank_lost_impression_share")
  END AS "search_rank_lost_impression_share",
  BOOL_OR("has_sitelinks") AS "has_sitelinks",
  MAX("sitelink_count") AS "sitelink_count",
  BOOL_OR("has_callouts") AS "has_callouts",
  MAX("callout_count") AS "callout_count",
  BOOL_OR("has_structured_snippets") AS "has_structured_snippets",
  MAX("structured_snippet_count") AS "structured_snippet_count",
  BOOL_OR("has_image_assets") AS "has_image_assets",
  MAX("image_asset_count") AS "image_asset_count",
  SUM("keyword_broad_impressions")::integer AS "keyword_broad_impressions",
  SUM("keyword_broad_clicks")::integer AS "keyword_broad_clicks",
  SUM("keyword_broad_cost_micros")::bigint AS "keyword_broad_cost_micros",
  SUM("keyword_broad_conversions")::double precision AS "keyword_broad_conversions",
  SUM("keyword_broad_conversions_value")::double precision AS "keyword_broad_conversions_value",
  SUM("keyword_phrase_impressions")::integer AS "keyword_phrase_impressions",
  SUM("keyword_phrase_clicks")::integer AS "keyword_phrase_clicks",
  SUM("keyword_phrase_cost_micros")::bigint AS "keyword_phrase_cost_micros",
  SUM("keyword_phrase_conversions")::double precision AS "keyword_phrase_conversions",
  SUM("keyword_phrase_conversions_value")::double precision AS "keyword_phrase_conversions_value",
  SUM("keyword_exact_impressions")::integer AS "keyword_exact_impressions",
  SUM("keyword_exact_clicks")::integer AS "keyword_exact_clicks",
  SUM("keyword_exact_cost_micros")::bigint AS "keyword_exact_cost_micros",
  SUM("keyword_exact_conversions")::double precision AS "keyword_exact_conversions",
  SUM("keyword_exact_conversions_value")::double precision AS "keyword_exact_conversions_value",
  MIN("created_at") AS "created_at"
FROM "campaign_benchmark_snapshots"
GROUP BY "account_id", "campaign_id", "snapshot_date";

DROP INDEX IF EXISTS "campaign_benchmark_account_campaign_date_segment_idx";
DROP INDEX IF EXISTS "campaign_benchmark_account_campaign_date_idx";
DROP INDEX IF EXISTS "campaign_benchmark_peer_slice_idx";
DROP INDEX IF EXISTS "campaign_benchmark_channel_date_idx";

TRUNCATE TABLE "campaign_benchmark_snapshots" RESTART IDENTITY;

INSERT INTO "campaign_benchmark_snapshots" (
  "account_id", "campaign_id", "snapshot_date", "ad_network_type", "device",
  "campaign_name", "campaign_status", "advertising_channel_type", "bidding_strategy_type",
  "currency_code", "time_zone", "industry_category", "business_niche", "business_domain",
  "geo_target_count", "negative_geo_target_count", "language_target_count",
  "geo_target_constants", "language_constants",
  "impressions", "clicks", "cost_micros", "conversions", "conversions_value",
  "search_impression_share", "search_top_impression_share", "search_absolute_top_impression_share",
  "search_budget_lost_impression_share", "search_rank_lost_impression_share",
  "has_sitelinks", "sitelink_count", "has_callouts", "callout_count",
  "has_structured_snippets", "structured_snippet_count", "has_image_assets", "image_asset_count",
  "keyword_broad_impressions", "keyword_broad_clicks", "keyword_broad_cost_micros",
  "keyword_broad_conversions", "keyword_broad_conversions_value",
  "keyword_phrase_impressions", "keyword_phrase_clicks", "keyword_phrase_cost_micros",
  "keyword_phrase_conversions", "keyword_phrase_conversions_value",
  "keyword_exact_impressions", "keyword_exact_clicks", "keyword_exact_cost_micros",
  "keyword_exact_conversions", "keyword_exact_conversions_value", "created_at"
)
SELECT
  "account_id", "campaign_id", "snapshot_date", "ad_network_type", "device",
  "campaign_name", "campaign_status", "advertising_channel_type", "bidding_strategy_type",
  "currency_code", "time_zone", "industry_category", "business_niche", "business_domain",
  "geo_target_count", "negative_geo_target_count", "language_target_count",
  COALESCE("geo_target_constants", '[]'::jsonb), COALESCE("language_constants", '[]'::jsonb),
  "impressions", "clicks", "cost_micros", "conversions", "conversions_value",
  "search_impression_share", "search_top_impression_share", "search_absolute_top_impression_share",
  "search_budget_lost_impression_share", "search_rank_lost_impression_share",
  "has_sitelinks", "sitelink_count", "has_callouts", "callout_count",
  "has_structured_snippets", "structured_snippet_count", "has_image_assets", "image_asset_count",
  "keyword_broad_impressions", "keyword_broad_clicks", "keyword_broad_cost_micros",
  "keyword_broad_conversions", "keyword_broad_conversions_value",
  "keyword_phrase_impressions", "keyword_phrase_clicks", "keyword_phrase_cost_micros",
  "keyword_phrase_conversions", "keyword_phrase_conversions_value",
  "keyword_exact_impressions", "keyword_exact_clicks", "keyword_exact_cost_micros",
  "keyword_exact_conversions", "keyword_exact_conversions_value", "created_at"
FROM "campaign_benchmark_snapshots_rollup";

ALTER TABLE "campaign_benchmark_snapshots"
  ALTER COLUMN "ad_network_type" SET DEFAULT 'ALL',
  ALTER COLUMN "device" SET DEFAULT 'ALL';

CREATE UNIQUE INDEX "campaign_benchmark_account_campaign_date_idx"
  ON "campaign_benchmark_snapshots" ("account_id", "campaign_id", "snapshot_date");

CREATE INDEX "campaign_benchmark_peer_slice_idx"
  ON "campaign_benchmark_snapshots" ("industry_category", "business_niche", "currency_code", "advertising_channel_type", "snapshot_date");

CREATE INDEX "campaign_benchmark_channel_date_idx"
  ON "campaign_benchmark_snapshots" ("advertising_channel_type", "snapshot_date");

COMMIT;
