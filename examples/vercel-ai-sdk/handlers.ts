// Pure tool handlers, as plain named async functions. Kept separate from the
// `tool()` definitions so they read cleanly on their own — and so `verify()`,
// which statically scans source, can see `lookup_order` / `issue_refund` /
// `send_email` and check the spec's ordering and reference claims against them.

// A tiny in-memory "order book" so the handlers return something real.
const ORDERS: Record<string, { total: number; customer: string }> = {
  "ORD-1001": { total: 42.5, customer: "ada@example.com" },
  "ORD-2002": { total: 130.0, customer: "grace@example.com" },
};

export async function lookup_order({ order_id }: { order_id: string }) {
  const order = ORDERS[order_id];
  if (!order) return { found: false as const, order_id };
  return { found: true as const, order_id, total: order.total, customer: order.customer };
}

export async function issue_refund({
  order_id,
  amount,
}: {
  order_id: string;
  amount: number;
}) {
  return { refunded: true as const, order_id, amount, confirmation: `RF-${order_id}` };
}

export async function send_email({ to }: { to: string; body: string }) {
  return { sent: true as const, to };
}
