-- Store the representative Google Ads landing/final URL used for benchmark
-- account-level industry/niche enrichment. Nullable so existing snapshots do
-- not need a rewrite.

ALTER TABLE "campaign_benchmark_snapshots"
  ADD COLUMN IF NOT EXISTS "business_landing_page_url" text;
