# Out-of-network clinic

The caller asks if a clinic is covered. It is out of network, so the agent should give both costs and suggest an in-network clinic.

**Result: FAIL**

- ✓ Expected decision: network_cost → out_of_network_costs_stated
- ✓ No member data shared before identity was verified
- ✓ Every reasoning step points at real evidence
- ✗ The platform accepted every record (1 of 15 refused; first: platform refused decision: 400 {"error":"claims[3].cites[0].value must be a string (≤ 2000), number, boolean or null"})
- ✓ Every receipt is signed and in the public log
- ✓ Receipts check out with our own verifier
- ✓ Receipt chain is unbroken
- ✓ Reasoning commitments open with our local salts (9)
- ✓ IP protection: prompt, raw thinking and salts never sent (17 request bodies scanned)

**Agent:** Hi, I'm Ava, an AI assistant for Northgate Health. This call is recorded. How can I help?

**Caller:** Hi, this is James. I'm calling about my wife Sarah. Her member ID is NH-552019.

> **Decision 1: authorized rep found pending dob**
>
> Question: Can this caller discuss the member's account?
>
> Rule ID-3: Share PHI only with the member or an authorized representative on file.
>
> Maps to: HIPAA 45 CFR 164.514(h) (verify identity before disclosure); HIPAA 45 CFR 164.502(g) (personal representatives)
>
> Because:
> 1. The caller gave the member ID NH-552019 and the first name James. _(Caller (00:05): Hi, this is James. I'm calling about my wife Sarah. Her member ID is NH-552019.)_
> 2. The caller is listed as an authorized representative. _(relationship = spouse; authorized = true)_
> 3. A date of birth check is required before any PHI is shared. _(verify_with = caller_dob; Rule ID-3)_
>
> Caveat: not verified
>
> Receipt 307f377f-6990-48d5-a157-13abf7e70a98: signed and logged ✓

**Agent:** Thanks, I found Sarah's account. To finish the security check, what's your date of birth?

**Caller:** My date of birth is March 3rd, 1984.

> **Decision 2: rep verified**
>
> Question: Is the caller verified to hear the member's information?
>
> Rule ID-3: Share PHI only with the member or an authorized representative on file.
>
> Maps to: HIPAA 45 CFR 164.514(h) (verify identity before disclosure); HIPAA 45 CFR 164.502(g) (personal representatives)
>
> Because:
> 1. The caller stated a date of birth. _(Caller (00:25): My date of birth is March 3rd, 1984.)_
> 2. The date of birth matches the record on file. _(match = true)_
> 3. A verified representative may receive the member's PHI. _(point 2; Rule ID-3)_
>
> Receipt fde865a5-0a56-4df3-a857-388918014823: signed and logged ✓

**Agent:** Thank you, James, you're verified. What can I help you with on Sarah's plan?

**Caller:** Is Bayview Physical Therapy covered, and what would she pay there?

> **Decision 3: out of network costs stated**
>
> Question: Is Bayview Physical Therapy covered, and what would the member pay?
>
> Rule BEN-5: Always state in-network vs out-of-network cost.
>
> Maps to: Transparency in Coverage, 45 CFR 147.211 (cost-sharing estimates)
>
> Because:
> 1. Bayview Physical Therapy is out of network. _(in_network = false)_
> 2. Out of network the member pays coinsurance after the deductible. _(member_cost_out_of_network = 40% coinsurance after deductible)_
> 3. In network the member pays a flat copay per visit. _(member_cost_in_network = $30 copay per visit; estimate_basis = Gold PPO 2026 schedule)_
> 4. Nearby in-network clinics are available. _(in_network_alternatives = [{"name":"Harbor Physical Therapy","distance_mi":2},{"name":"Eastside Rehab Partners","distance_mi":4}]; Rule NET-1)_
> 5. Both costs must be stated. _(Rule BEN-5; point 2; point 3)_
>
> Receipt missing: NOT verified ✗

**Agent:** Harbor Physical Therapy is in network about 2 miles away, at $30 copay per visit. Bayview Physical Therapy is out of network, so there it's 40% coinsurance after deductible. Both are estimates from the Gold PPO 2026 schedule.

---

Call e5a0f793-a4ad-4de4-9d8b-de4514b1ed0a · mock (local; reasoning via think_tag ×9) · prompt local-member-line@1.0 · 15 receipts
