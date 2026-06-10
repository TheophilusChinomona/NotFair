ALTER TABLE ad_platform_connections
ADD COLUMN IF NOT EXISTS account_health jsonb NOT NULL DEFAULT '{}'::jsonb;
