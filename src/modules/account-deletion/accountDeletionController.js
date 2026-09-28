import { readJson, sendError, sendJson } from "../../shared/http.js";
import { buildClearCookies } from "../auth/authController.js";
import { deleteAccount } from "./accountDeletionService.js";

export async function handleAccountDeletionRoutes(req, res, pathname) {
  if (pathname !== "/api/account") {
    return false;
  }

  if (req.method !== "DELETE") {
    return sendError(res, 405, "Method not allowed.");
  }

  if (!req.user) {
    return sendError(res, 401, "Authentication required.");
  }

  try {
    const result = await deleteAccount(req.user, await readJson(req), req);
    return sendJson(res, 200, result, { "set-cookie": buildClearCookies() });
  } catch (error) {
    const statusCode = error.statusCode || 500;
    if (statusCode >= 500) {
      console.error(
        `[account-deletion] failed user=${req.user.id} reason=${error.message}` +
        (error.cause?.message ? ` cause=${error.cause.message}` : "")
      );
    }
    return sendError(res, statusCode, statusCode >= 500 && !error.statusCode
      ? "Account deletion failed. Your account data was not deleted."
      : error.message, error.code ? { code: error.code } : undefined);
  }
}
