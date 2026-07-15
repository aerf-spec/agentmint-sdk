// Pure tool handlers, as plain named async functions. Kept separate from the
// `tool()` definitions so they read cleanly on their own, and so `verify()`,
// which statically scans source, can see `lookup_auth` / `submit_prior_auth` /
// `notify_payer` and check the spec's ordering and reference claims against them.

// A tiny in-memory "authorization file" so the handlers return something real.
const AUTHS: Record<string, { authorized_amount: number; payer: string }> = {
  "PA-2210": { authorized_amount: 42.5, payer: "aetna@example.com" },
  "PA-3302": { authorized_amount: 130.0, payer: "cigna@example.com" },
};

export async function lookup_auth({ auth_id }: { auth_id: string }) {
  const auth = AUTHS[auth_id];
  if (!auth) return { found: false as const, auth_id };
  return { found: true as const, auth_id, authorized_amount: auth.authorized_amount, payer: auth.payer };
}

export async function submit_prior_auth({
  auth_id,
  billed_amount,
}: {
  auth_id: string;
  billed_amount: number;
}) {
  return { submitted: true as const, auth_id, billed_amount, confirmation: `PAX-${auth_id}` };
}

export async function notify_payer({ to }: { to: string; body: string }) {
  return { sent: true as const, to };
}
