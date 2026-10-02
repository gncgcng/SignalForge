-- Trading-session calendars referenced by markets.session_calendar_id. The session rules themselves
-- (hours, holidays, DST) live in src/modules/markets/sessionService.js; this table pins the ids so a
-- market cannot reference a calendar that does not exist. Purely additive.
CREATE TABLE IF NOT EXISTS trading_session_calendars (
  id text PRIMARY KEY,
  name text NOT NULL,
  timezone text NOT NULL,
  description text,
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO trading_session_calendars (id, name, timezone, description) VALUES (
  'us_commodity_week',
  'US commodity week',
  'America/New_York',
  'Sunday 17:00 to Friday 17:00 New York time (DST-aware); closed New Year''s Day, Good Friday and Christmas; early halt on US federal market holidays.'
) ON CONFLICT (id) DO NOTHING;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'markets_session_calendar_fk') THEN
    ALTER TABLE markets ADD CONSTRAINT markets_session_calendar_fk
      FOREIGN KEY (session_calendar_id) REFERENCES trading_session_calendars (id);
  END IF;
END $$;

UPDATE markets
SET session_calendar_id = 'us_commodity_week', exchange_timezone = 'America/New_York', updated_at = now()
WHERE asset_class = 'commodity' AND session_calendar_id IS NULL;

-- NULL session_calendar_id means "trades 24/7". Only crypto does; any other market that is routed
-- to a real provider must name its calendar, so enabling a provider for a stock placeholder can't
-- silently make it an always-open market.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'markets_session_calendar_required') THEN
    ALTER TABLE markets ADD CONSTRAINT markets_session_calendar_required
      CHECK (asset_class = 'crypto' OR provider = 'none' OR session_calendar_id IS NOT NULL);
  END IF;
END $$;
