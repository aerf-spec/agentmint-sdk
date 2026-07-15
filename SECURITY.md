# Security

## Reporting

If you can make a receipt lie, make a deletion invisible, or bypass a rule, that
is a bug worth reporting. Email [aniketh@agentmint.run](mailto:aniketh@agentmint.run)
with a failing vector or test if you can. We aim to acknowledge within three
business days. Please do not open a public issue for an unpatched break.

## Supported versions

The 0.3.x line receives security fixes. Older versions do not. Pin a version
and upgrade when a fix ships.

| Version | Supported |
|---|---|
| 0.3.x | Yes |
| < 0.3 | No |

## The signing model, in plain terms

Every receipt is signed with your private key the moment an action happens, and
each receipt carries the fingerprint of the one before it. Changing any field
breaks that receipt's signature. Removing a receipt breaks the link and the
sequence on both sides. Anyone with your public key can check all of this
offline, so a record cannot be revised after the fact without the check catching
it and naming what changed. The key lives in your process, which is the trust
boundary: agentmint proves a record was not altered after it was signed, not
that the signer was honest at signing time. Key custody and rotation are your
job. The full threat model, including what a receipt does not prove, is in
[THREAT-MODEL.md](THREAT-MODEL.md).
