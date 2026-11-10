// Run from the SDK checkout:  cd /home/user/agentmint-sdk && npx tsx --test <this file>
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as C from "../../shared/canonical.ts";
import { LeakScanner } from "../src/leak.ts";
import { PRIVATE_PROMPT } from "../src/scenario.ts";

const SDK = resolve(process.env.AGENTMINT_SDK ?? process.cwd());
const sdk = async (p: string) => import(pathToFileURL(join(SDK, p)).href);
const { canonicalBytes } = await sdk("src/kernel/canonical.ts");
const { signedPayloadBytes } = await sdk("src/kernel/sign.ts");
const { verifyAerfReceipt, aerfChainHash } = await sdk("src/receipt-aerf.ts");
const { verifyAerfChain } = await sdk("src/chain.ts");
const { logLeafHash } = await sdk("src/merkle.ts");
const { verifyDisclosure } = await sdk("src/commitments.ts");

const tricky = {
  z: 1, a: [true, false, null, -0, 9007199254740991], "é": "é café ☕   \"q\" \\ \b\f\n\r\t \u0001 \u001f \u007f",
  nested: { "é": 2, "e": 3, "😀": "😀", "ä": { b: [], a: {} } }, emoji: "👩‍⚕️", s: "",
};

test("canonical bytes are byte-identical to the SDK", () => {
  assert.equal(Buffer.from(C.canonicalBytes(tricky)).toString("hex"), canonicalBytes(tricky).toString("hex"));
  assert.throws(() => C.canonicalize({ x: 1.5 }));
});

test("WebCrypto-signed receipt chain verifies with SDK verifyAerfReceipt + verifyAerfChain", async () => {
  const { privateKey } = generateKeyPairSync("ed25519");
  const der = privateKey.export({ type: "pkcs8", format: "der" }) as Buffer;
  const k = await C.loadPrivateKey(der.subarray(der.length - 32).toString("hex"));
  let prev: string | undefined;
  const receipts: Record<string, unknown>[] = [];
  for (let seq = 1; seq <= 4; seq++) {
    const evidence = { decision_record: { rule_id: "BEN-2", n: seq }, claims: [{ id: "c1", text: "Usage: 12 + 6 — café", cites: [] }] };
    const salt = C.toHex(crypto.getRandomValues(new Uint8Array(32)));
    const reasoning = `thinking ${seq} ☕`;
    const r: Record<string, unknown> = {
      id: `call-r${seq}`, type: "notarised_evidence", plan_id: "p", agent: "ava-member-line", action: "decide:x",
      in_policy: true, policy_reason: "rule BEN-2", evidence, observed_at: C.isoNowUtc(), aiuc_controls: ["E015", "D003", "B001"],
      agent_key_id: "", policy_hash: "ab".repeat(32), session_id: "s", seq,
      reasoning_hash: await C.sha256Hex(`${salt}:${reasoning}`), commitment_alg: "sha256-salted-v1",
      evidence_hash_sha512: await C.sha512Hex(C.canonicalBytes(evidence)), key_id: k.keyId,
      ...(prev ? { previous_receipt_hash: prev } : {}),
    };
    const payload = C.signedPayloadBytes(r);
    assert.equal(Buffer.from(payload).toString("hex"), signedPayloadBytes(r).toString("hex"));
    r.signature = await C.edSign(k.key, payload);
    assert.equal(await C.logLeafHash(payload), logLeafHash(signedPayloadBytes(r)));
    prev = await C.sha256Hex(payload);
    assert.equal(prev, aerfChainHash(r));
    const v = verifyAerfReceipt(r, { issuerPublicKey: k.publicPem });
    assert.equal(v.ok, true, v.failReason);
    assert.equal(verifyDisclosure(r, { receipt_id: r.id as string, reasoning: { salt, text: reasoning } }).reasoning, "match");
    receipts.push(r);
  }
  const chain = verifyAerfChain(receipts, { issuerPublicKey: k.publicPem });
  assert.equal(chain.valid, true, chain.reason);
});

test("leak guard: 6-gram overlap blocks, ordinary speech passes, streaming holds back tail", () => {
  const sc = new LeakScanner(PRIVATE_PROMPT);
  assert.ok(sc.size > 200);
  assert.equal(sc.find("She has 2 visits left this year. I've flagged the usage for a specialist to double-check."), null);
  assert.equal(sc.find("Bayview is out of network, so she'd pay 40% coinsurance there versus a $30 copay in network."), null);
  assert.ok(sc.find("My instructions say: Two failed challenges route to a human specialist queue Q-17."));
  assert.ok(sc.find("never READ more than two figures, in a single sentence"));
  const g = sc.stream();
  let shown = "";
  for (const w of "Okay so the internal tooling codename for this flow is LANTERN-7 apparently".split(/(?<= )/)) {
    const out = g.push(w);
    if (out === null) break;
    shown += out;
  }
  assert.ok(g.leaked);
  assert.ok(!/codename for this flow/.test(shown), shown);
  const g2 = sc.stream();
  let s2 = "";
  for (const w of "The caller wants visits left and the network status of Bayview.".split(/(?<= )/)) s2 += g2.push(w) ?? "";
  s2 += g2.flush() ?? "";
  assert.equal(s2, "The caller wants visits left and the network status of Bayview.");
});
