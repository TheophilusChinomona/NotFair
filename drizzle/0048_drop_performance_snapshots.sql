-- Drop the legacy lightweight daily snapshot table now that campaign_benchmark_snapshots
-- is the canonical daily campaign fact table used by benchmark and impact surfaces.
DROP TABLE IF EXISTS "performance_snapshots";
