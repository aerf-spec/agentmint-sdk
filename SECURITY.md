# Security policy

## Reporting a vulnerability

If you find a way to make a receipt lie, to make a deletion invisible, or to
bypass a policy rule in a way the [threat model](THREAT-MODEL.md) does not
already list, please report it privately first. Email
[aniketh@agentmint.run](mailto:aniketh@agentmint.run) with a description and,
where possible, a failing vector or test that demonstrates the issue. Please
allow a reasonable window for a fix before any public disclosure. Reports that
turn out to be known and documented limits are still welcome, and we will point
you to where they are recorded.

## Supported versions

The project follows semantic versioning. Security fixes land on the latest
minor release line, currently `0.3.x`. Older `0.x` lines are not maintained;
if you are on one, the fix is to upgrade to the current release.

| Version | Supported |
|---|---|
| 0.3.x | Yes |
| < 0.3 | No, please upgrade |

## The signing model, in brief

Every receipt is signed with an Ed25519 private key held inside the application
process that runs the agent, and it is verified later with the matching public
key, which can be shared freely and can only check signatures, never create
them. Each receipt also carries the fingerprint of the receipt before it, so the
receipts form a hash chain: editing any signed field breaks that receipt's
signature, and removing a receipt breaks the chain and the sequence numbers on
both sides. The signing key is what the security of the whole record rests on.
Anyone holding it can sign a truthful receipt or a false one, so key custody,
rotation, and hardware protection are the host's responsibility. For high impact
actions, the format supports a second, independent signature so that one stolen
key is not enough. Verification needs only Node and the public key, so a buyer
can confirm a packet without trusting or running anything from the vendor or
from us.
