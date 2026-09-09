ALTER TABLE generated_signals
  ADD COLUMN IF NOT EXISTS calibrated_confidence numeric,
  ADD COLUMN IF NOT EXISTS confidence_version text NOT NULL DEFAULT 'calibration_v1',
  ADD COLUMN IF NOT EXISTS calibration_reason text;

UPDATE generated_signals
SET
  calibrated_confidence = COALESCE(calibrated_confidence, confidence),
  confidence_version = COALESCE(NULLIF(confidence_version, ''), COALESCE(confidence_calibration->>'version', 'calibration_v1')),
  calibration_reason = COALESCE(calibration_reason, confidence_calibration->>'calibrationReason', confidence_calibration->>'message')
WHERE calibrated_confidence IS NULL
   OR calibration_reason IS NULL
   OR confidence_version IS NULL
   OR confidence_version = '';

CREATE INDEX IF NOT EXISTS idx_generated_signals_calibrated_confidence
  ON generated_signals (calibrated_confidence, created_at DESC);
