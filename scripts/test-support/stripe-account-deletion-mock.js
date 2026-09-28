// In-memory Stripe for the account-deletion tests: subscriptions (list/cancel) and customers
// (retrieve/delete), mimicking Stripe's response shapes. Installs itself as globalThis.fetch.
export function installStripeAccountDeletionMock() {
  const mock = {
    calls: [],
    // customerId -> array of { id, status, ...flags }
    customers: {},
    deletedCustomers: new Set(),
    // Shrink Stripe's page size so pagination is testable.
    pageSize: null,
    // Fail a given list page: { page, status, body } or { page, network: true }.
    failList: null,
    // Fail the customer DELETE: { status, body } or { network: true }.
    failCustomerDelete: null,
    reset(customers = {}, { pageSize = null, failList = null, failCustomerDelete = null, deletedCustomers = [] } = {}) {
      mock.calls.length = 0;
      mock.customers = customers;
      mock.deletedCustomers = new Set(deletedCustomers);
      mock.pageSize = pageSize;
      mock.failList = failList;
      mock.failCustomerDelete = failCustomerDelete;
    },
    deletes: () => mock.calls.filter((c) => c.method === "DELETE"),
    gets: () => mock.calls.filter((c) => c.method === "GET"),
    trace: () => mock.calls.map((c) => `${c.method} ${c.path}`)
  };

  const json = (status, body) => ({ ok: status < 400, status, json: async () => body });
  const missing = (message, param) => json(param === "customer" ? 400 : 404, {
    error: { code: "resource_missing", param, type: "invalid_request_error", message }
  });

  globalThis.fetch = async (url, init = {}) => {
    const method = init.method || "GET";
    const path = String(url).replace("https://api.stripe.com/v1", "");
    mock.calls.push({ method, path });

    if (method === "GET" && path.startsWith("/subscriptions?")) {
      const params = new URL(`https://x${path}`).searchParams;
      const customer = params.get("customer");
      const pageNumber = mock.calls.filter((c) => c.method === "GET" && c.path.startsWith("/subscriptions?")).length;
      if (mock.failList?.page === pageNumber) {
        if (mock.failList.network) throw new TypeError("fetch failed");
        return json(mock.failList.status, mock.failList.body);
      }
      if (!mock.customers[customer] || mock.deletedCustomers.has(customer)) {
        return missing(`No such customer: '${customer}'`, "customer");
      }
      // Like Stripe: without a status filter, canceled subscriptions are omitted.
      const visible = params.get("status") === "all"
        ? mock.customers[customer]
        : mock.customers[customer].filter((item) => item.status !== "canceled");
      const startingAfter = params.get("starting_after");
      const start = startingAfter ? visible.findIndex((item) => item.id === startingAfter) + 1 : 0;
      const limit = mock.pageSize || Number(params.get("limit") || 10);
      const data = visible.slice(start, start + limit);
      return json(200, { object: "list", data, has_more: start + limit < visible.length });
    }

    const subMatch = path.match(/^\/subscriptions\/([^/?]+)$/);
    if (method === "DELETE" && subMatch) {
      for (const subs of Object.values(mock.customers)) {
        const sub = subs.find((item) => item.id === subMatch[1]);
        if (sub) {
          if (sub.canceledConcurrently) sub.status = "canceled";
          if (sub.status === "canceled") {
            return json(400, { error: { message: "A canceled subscription can only update its cancellation_details and metadata." } });
          }
          sub.status = sub.failCancel ? sub.status : "canceled";
          return json(200, { ...sub });
        }
      }
      return missing("No such subscription", "id");
    }

    const customerMatch = path.match(/^\/customers\/([^/?]+)$/);
    if (customerMatch) {
      const id = decodeURIComponent(customerMatch[1]);
      if (method === "GET") {
        // Stripe returns a stub for a deleted customer rather than a 404.
        if (mock.deletedCustomers.has(id)) return json(200, { id, object: "customer", deleted: true });
        if (mock.customers[id]) return json(200, { id, object: "customer" });
        return missing(`No such customer: '${id}'`, "id");
      }
      if (method === "DELETE") {
        if (mock.failCustomerDelete) {
          if (mock.failCustomerDelete.network) throw new TypeError("fetch failed");
          return json(mock.failCustomerDelete.status, mock.failCustomerDelete.body);
        }
        if (!mock.customers[id] || mock.deletedCustomers.has(id)) return missing(`No such customer: '${id}'`, "id");
        // Deleting a customer cancels all of its subscriptions.
        for (const sub of mock.customers[id]) sub.status = "canceled";
        mock.deletedCustomers.add(id);
        return json(200, { id, object: "customer", deleted: true });
      }
    }
    throw new Error(`Unexpected Stripe call ${method} ${path}`);
  };

  return mock;
}
