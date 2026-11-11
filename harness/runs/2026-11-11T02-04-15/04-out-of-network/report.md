# Out-of-network clinic

The caller asks if a clinic is covered. It is out of network, so the agent should give both costs and suggest an in-network clinic.

**Result: PASS**

- ✓ Expected decision: network_cost → out_of_network_costs_stated
- ✓ No member data shared before identity was verified
- ✓ Every reasoning step points at real evidence
- ✓ Every receipt is signed and in the public log
- ✓ Receipts check out with our own verifier
- ✓ Receipt chain is unbroken

**Agent:** Hi, I'm Ava, an AI assistant for Northgate Health. This call is recorded. How can I help?

**Caller:** Hi, this is James. I'm calling about my wife Sarah. Her member ID is NH-552019.

> **Decision 1: authorized rep found pending dob**
>
> Question: Can James discuss member NH-552019's account?
>
> Rule ID-3: Share PHI only with the member or an authorized representative on file.
>
> Because:
> 1. Caller gave name James and member ID NH-552019. _(Caller (00:00): Hi, this is James. I'm calling about my wife Sarah. Her member ID is NH-552019.)_
> 2. A caller named James is listed as an authorized representative. _(authorized = true; relationship = spouse)_
> 3. Verification requires the caller's date of birth before sharing PHI. _(verify_with = caller_dob; Rule ID-3; point 2)_
>
> Caveat: not verified
>
> Receipt c075f15a-f82d-4821-89c2-b97ef39cd3bb-r4: signed and logged ✓

**Agent:** Thanks. Before we go on, I need to verify who I'm speaking with. Can you please tell me your own date of birth?

**Caller:** My date of birth is March 3rd, 1984.

> **Decision 2: rep verified**
>
> Question: Is James verified as an authorized representative for NH-552019?
>
> Rule ID-3: Share PHI only with the member or an authorized representative on file.
>
> Because:
> 1. Caller gave date of birth 1984-03-03. _(Caller (00:07): My date of birth is March 3rd, 1984.)_
> 2. Date of birth matched the representative record on the first attempt. _(match = true; attempts = 1; point 1)_
> 3. James is a verified authorized representative and may receive the member's PHI. _(point 2; Rule ID-3)_
>
> Receipt c075f15a-f82d-4821-89c2-b97ef39cd3bb-r8: signed and logged ✓

**Agent:** I've verified you, James. You're on file as Sarah's authorized representative. How can I help with her plan today?

**Caller:** Is Bayview Physical Therapy covered, and what would she pay there?

> **Decision 3: out of network costs stated**
>
> Question: Is Bayview Physical Therapy covered, and what would Sarah pay there?
>
> Rule BEN-5: Always state in-network vs out-of-network cost.
>
> Because:
> 1. Caller asked about coverage and cost at Bayview Physical Therapy. _(Caller (00:13): Is Bayview Physical Therapy covered, and what would she pay there?)_
> 2. Bayview Physical Therapy is out of network. _(in_network = false)_
> 3. Out-of-network cost is 40% coinsurance after deductible. _(member_cost_out_of_network = 40% coinsurance after deductible; Rule BEN-5)_
> 4. In-network cost is a $30 copay per visit. _(member_cost_in_network = $30 copay per visit; Rule BEN-5)_
> 5. Figures are estimates based on the Gold PPO 2026 schedule. _(estimate_basis = Gold PPO 2026 schedule; Rule COST-1)_
> 6. Harbor Physical Therapy, 2 miles away, is a nearby in-network alternative. _(in_network_alternatives = [{"name":"Harbor Physical Therapy","distance_mi":2},{"name":"Eastside Rehab Partners","distance_mi":4}]; Rule NET-1; point 2)_
>
> Receipt c075f15a-f82d-4821-89c2-b97ef39cd3bb-r12: signed and logged ✓

**Agent:** I found the answer, James. Bayview Physical Therapy is out of network for Sarah. There, she'd pay 40 percent of the cost after her deductible. At an in-network clinic, she'd pay a 30 dollar copay per visit. These are estimates based on her Gold PPO plan for 2026. Harbor Physical Therapy is in network and about 2 miles away. Would you like to hear more about that?

---

Call c075f15a-f82d-4821-89c2-b97ef39cd3bb · claude-opus-5-5 · prompt member-line@14.2 · 14 receipts · $0.058
