CREATE TABLE IF NOT EXISTS promo_codes (
  id text PRIMARY KEY,
  code text NOT NULL UNIQUE,
  type text NOT NULL CHECK (type IN ('stripe_discount', 'credit_grant')),
  max_redemptions integer NOT NULL CHECK (max_redemptions > 0),
  expires_at timestamptz,
  active boolean NOT NULL DEFAULT true,
  created_by_admin_id text NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),

  stripe_coupon_id text,
  stripe_promotion_code_id text,
  discount_percent_off integer CHECK (discount_percent_off IS NULL OR (discount_percent_off > 0 AND discount_percent_off <= 100)),
  discount_amount_off_cents integer CHECK (discount_amount_off_cents IS NULL OR discount_amount_off_cents > 0),

  credit_quantity integer CHECK (credit_quantity IS NULL OR credit_quantity > 0),

  CONSTRAINT stripe_discount_fields CHECK (
    type != 'stripe_discount' OR (stripe_coupon_id IS NOT NULL AND stripe_promotion_code_id IS NOT NULL)
  ),
  CONSTRAINT credit_grant_fields CHECK (
    type != 'credit_grant' OR credit_quantity IS NOT NULL
  ),
  CONSTRAINT stripe_discount_single_kind CHECK (
    type != 'stripe_discount' OR (
      (discount_percent_off IS NOT NULL) IS DISTINCT FROM (discount_amount_off_cents IS NOT NULL)
    )
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_promo_codes_stripe_promotion_code
  ON promo_codes(stripe_promotion_code_id)
  WHERE stripe_promotion_code_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS promo_code_redemptions (
  id text PRIMARY KEY,
  promo_code_id text NOT NULL REFERENCES promo_codes(id),
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  redeemed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (promo_code_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_promo_code_redemptions_code ON promo_code_redemptions(promo_code_id);
