# Any caller, any member

A made-up caller and member ID. In test mode there are no credential blockers, so the agent verifies and answers using invented but believable member data.

**Result: PASS**

- ✓ Expected decision: dob_verification → rep_verified
- ✓ Expected decision: visits_remaining
- ✓ Expected decision: network_cost → in_network_cost_stated
- ✓ No member data shared before identity was verified
- ✓ Every reasoning step points at real evidence
- ✓ The platform accepted every record
- ✓ Every receipt is signed and in the public log
- ✓ Receipts check out with our own verifier
- ✓ Receipt chain is unbroken
- ✓ Reasoning commitments open with our local salts (11)
- ✓ IP protection: prompt, raw thinking and salts never sent (21 request bodies scanned)

**Agent:** Hi, I'm Ava, an AI assistant for Northgate Health. This call is recorded. How can I help?

**Caller:** Hi, I'm Daniel Ortiz, calling for my mother. Her member ID is NH-310877.

> **Decision 1: authorized rep found pending dob**
>
> Question: Can this caller discuss the member's account?
>
> Rule ID-3: Share PHI only with the member or an authorized representative on file.
>
> Maps to: HIPAA 45 CFR 164.514(h) (verify identity before disclosure); HIPAA 45 CFR 164.502(g) (personal representatives)
>
> Because:
> 1. The caller gave the member ID NH-310877 and the first name Daniel. _(Caller (00:05): Hi, I'm Daniel Ortiz, calling for my mother. Her member ID is NH-310877.)_
> 2. The caller is listed as an authorized representative. _(relationship = authorized representative; authorized = true)_
> 3. A date of birth check is required before any PHI is shared. _(verify_with = caller_dob; Rule ID-3)_
>
> Caveat: not verified
>
> Receipt 10da337b-94df-4266-b33d-015e4815dc89: signed and logged ✓

**Agent:** Thanks, I found Aisha's account. To finish the security check, what's your date of birth?

**Caller:** My date of birth is May 12th, 1979.

> **Decision 2: rep verified**
>
> Question: Is the caller verified to hear the member's information?
>
> Rule ID-3: Share PHI only with the member or an authorized representative on file.
>
> Maps to: HIPAA 45 CFR 164.514(h) (verify identity before disclosure); HIPAA 45 CFR 164.502(g) (personal representatives)
>
> Because:
> 1. The caller stated a date of birth. _(Caller (00:25): My date of birth is May 12th, 1979.)_
> 2. The date of birth matches the record on file. _(match = true)_
> 3. A verified representative may receive the member's PHI. _(point 2; Rule ID-3)_
>
> Receipt d06c9c16-8ccd-49a3-bccf-24df913484c7: signed and logged ✓

**Agent:** Thank you, Daniel, you're verified. What can I help you with on Aisha's plan?

**Caller:** How many chiropractic visits does she have left, and is Harbor Physical Therapy in network?

> **Decision 3: remaining visits stated**
>
> Question: How many chiropractic visits does the member have left this year?
>
> Rule BEN-2: If usage counts conflict, give the confirmed number and flag the conflict. Never guess.
>
> Maps to: Plan accuracy policy: confirmed figures only, pending claims flagged
>
> Because:
> 1. The plan allows 30 chiropractic visits a year. _(allowedUnsignedInt = 30)_
> 2. 7 visits are confirmed as used. _(usedUnsignedInt = 7)_
> 3. 23 visits remain. _(point 1; point 2; Rule BEN-2)_
>
> Receipt 6b7a08c2-6327-4f15-9fdd-174d480e665c: signed and logged ✓

> **Decision 4: in network cost stated**
>
> Question: Is Harbor Physical Therapy covered, and what would the member pay?
>
> Rule BEN-5: Always state in-network vs out-of-network cost.
>
> Maps to: Transparency in Coverage, 45 CFR 147.211 (cost-sharing estimates)
>
> Because:
> 1. Harbor Physical Therapy is in network. _(in_network = true)_
> 2. The member pays the in-network copay. _(member_cost_in_network = $30 copay per visit; Rule BEN-5)_
>
> Receipt e06f30ec-9a97-4511-8f11-f9d7175c7825: signed and logged ✓

**Agent:** Aisha has 23 chiropractic visits left this year. Yes, Harbor Physical Therapy is in network: $30 copay per visit, estimated from the Gold PPO 2026 schedule.

---

Call e1f4788c-dd31-403c-8f29-4cee3d8099d7 · mock-rc (local; reasoning via reasoning_content ×11) · prompt local-member-line@1.0 · 20 receipts
