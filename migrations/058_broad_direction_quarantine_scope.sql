UPDATE signal_strategy_statuses
SET status = 'diagnostic_only',
    admin_note = 'Diagnostic only - direction-level performance is too broad to hard quarantine.',
    penalty_override = -3,
    confidence_cap_override = NULL,
    updated_at = now()
WHERE group_type = 'direction'
  AND status IN ('quarantined', 'disabled_by_admin');

UPDATE signal_performance_groups
SET status = 'diagnostic_only',
    suggested_status = 'diagnostic_only',
    penalty = GREATEST(penalty, -3),
    confidence_cap = NULL,
    updated_at = now()
WHERE group_type = 'direction'
  AND status IN ('quarantined', 'disabled_by_admin');
