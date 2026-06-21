import {
  createTesterAccessRequest,
  getLatestTesterAccessRequest,
  listPendingTesterAccessRequests,
  listAbuseReviewDashboard,
  reviewTesterAccessRequest
} from "../../db/repositories.js";
import { isAdminUser } from "../auth/authService.js";

export async function getTesterAccessStatus(user) {
  return {
    role: user.role || "user",
    request: await getLatestTesterAccessRequest(user.id)
  };
}

export async function requestTesterAccess(user) {
  if (user.role === "tester") {
    const error = new Error("This account already has tester access.");
    error.statusCode = 409;
    throw error;
  }

  return {
    role: user.role || "user",
    request: await createTesterAccessRequest(user.id)
  };
}

export async function getPendingTesterRequests(admin) {
  assertAdmin(admin);
  return {
    requests: await listPendingTesterAccessRequests()
  };
}

export async function getAbuseDashboard(admin) {
  assertAdmin(admin);
  return {
    abuse: await listAbuseReviewDashboard()
  };
}

export async function decideTesterRequest(admin, requestId, decision) {
  assertAdmin(admin);

  if (!["approved", "rejected"].includes(decision)) {
    const error = new Error("Decision must be approved or rejected.");
    error.statusCode = 400;
    throw error;
  }

  const request = await reviewTesterAccessRequest(requestId, admin.id, decision);

  if (!request) {
    const error = new Error("Pending tester request not found.");
    error.statusCode = 404;
    throw error;
  }

  return {
    request,
    requests: await listPendingTesterAccessRequests()
  };
}

function assertAdmin(user) {
  if (!isAdminUser(user)) {
    const error = new Error("Admin access required.");
    error.statusCode = 403;
    throw error;
  }
}
