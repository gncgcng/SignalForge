import { isAdminUser, reauthenticateWithPassword } from "../auth/authService.js";
import { cancelSubscription, deleteStripeCustomer } from "../subscriptions/stripeService.js";
import { countPendingAffiliatePayouts, deleteAccountData } from "./accountDeletionRepository.js";

export const DELETE_CONFIRMATION_PHRASE = "DELETE";

export async function deleteAccount(user, { password, confirmation } = {}, req) {
  if (String(confirmation || "").trim() !== DELETE_CONFIRMATION_PHRASE) {
    throw httpError(400, `Type ${DELETE_CONFIRMATION_PHRASE} to confirm account deletion.`, "confirmation_required");
  }
  // Admin rows are referenced ON DELETE RESTRICT by admin_support_audit_log and by
  // promo_codes.created_by_admin_id; admin access is also granted by email, so an
  // anonymized admin would silently lose it. Admins are removed by hand.
  if (user.role === "admin" || isAdminUser(user)) {
    throw httpError(403, "Admin accounts can't be deleted from settings. Contact another admin.", "admin_account");
  }

  const { emailHash } = await reauthenticateWithPassword(user, password, req);

  if (await countPendingAffiliatePayouts(user.id)) {
    throw httpError(409, "You have a pending affiliate payout. Wait for it to be reviewed before deleting your account.", "pending_payout");
  }

  // Must succeed before any data changes: never delete an account that is still being billed.
  const billing = await cancelSubscription(user);
  // Then remove the Stripe customer (and the PII Stripe holds on it). Only when this key can
  // reach it: checkedStripe is false for no customer, or one from the other Stripe mode.
  const customer = billing.checkedStripe
    ? await deleteStripeCustomer(user.subscription.providerCustomerId)
    : null;

  // Only the DB transaction is retried; the Stripe steps above already ran and are idempotent.
  const result = await deleteAccountDataWithRetry(user.id, {
    userId: user.id,
    email: user.email,
    loginEmailHash: emailHash
  });
  console.info(
    `[account-deletion] user=${user.id} canceled_subscriptions=${billing.canceledSubscriptionIds.length} ` +
    `stripe_customer=${customer ? (customer.alreadyDeleted ? "already_deleted" : "deleted") : "skipped"} ` +
    `already_deleted=${result.alreadyDeleted}`
  );
  return { deleted: true };
}

// Some transactions lock a child row before the users row (e.g. tester access review,
// Telegram code confirmation), so they can deadlock with this one, which locks users first.
// Postgres aborts one side with 40P01; serialization failures (40001) are equally safe to redo.
const RETRYABLE_TRANSACTION_CODES = new Set(["40P01", "40001"]);
const MAX_DELETE_ATTEMPTS = 3;

// Each attempt is a whole new transaction() on a fresh client, never a reused aborted one.
async function deleteAccountDataWithRetry(userId, args) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await deleteAccountData(args);
    } catch (error) {
      if (!RETRYABLE_TRANSACTION_CODES.has(error.code)) throw error;
      if (attempt >= MAX_DELETE_ATTEMPTS) {
        console.error(
          `[account-deletion] transaction failed after ${attempt} attempts user=${userId} code=${error.code} reason=${error.message}`
        );
        const retryable = httpError(503, "We couldn't finish deleting your account, so it was not deleted. Please try again.", "account_deletion_busy");
        retryable.cause = error;
        throw retryable;
      }
      const delayMs = 50 + Math.floor(Math.random() * 201);
      console.warn(
        `[account-deletion] transaction retry user=${userId} attempt=${attempt}/${MAX_DELETE_ATTEMPTS} code=${error.code} delay_ms=${delayMs}`
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

function httpError(statusCode, message, code) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}
