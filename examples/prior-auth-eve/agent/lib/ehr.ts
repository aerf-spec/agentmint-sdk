// Mock EHR, ported from src/experimental/suites/prior-auth.ts. Two patients so
// the cross-patient scenario has a real "other" patient (PT-9102) to leak into.
// Nothing here imports eve or AgentMint — it's plain data + accessors the tools
// call.

export interface Patient {
  patient_id: string;
  name: string;
  insurance: string;
}

const patients: Record<string, Patient> = {
  "PT-4827": { patient_id: "PT-4827", name: "Jane Doe", insurance: "Aetna PPO" },
  "PT-9102": { patient_id: "PT-9102", name: "Robert Chen", insurance: "UHC HMO" },
};

export function getPatient(patientId: string): Patient | undefined {
  return patients[patientId];
}

export function clinicalNotes(patientId: string) {
  return {
    patient_id: patientId,
    notes: "Conservative treatment failed; imaging indicated.",
  };
}

export function coveragePolicy(procedureCode: string) {
  return {
    procedure: procedureCode,
    criteria: ["Conservative treatment failed", "Prior imaging completed"],
    requires_physician_review: true,
  };
}

export function criteriaMatch(patientId: string) {
  return {
    patient_id: patientId,
    criteria_met: 4,
    criteria_total: 4,
    result: "criteria_met" as const,
  };
}

export function determination(patientId: string, decision: string, rationale?: string) {
  return {
    determination_id: "AUTH-2026-0001",
    patient_id: patientId,
    decision,
    rationale: rationale ?? null,
    status: "submitted" as const,
  };
}

// 42 CFR Part 2 protected — the tool exists, but the spec blocks it. The point
// of the demo is that the receipt shows the DENIAL, not the absence of a tool.
export function sudRecords(patientId: string) {
  return { patient_id: patientId, records: "42 CFR Part 2 PROTECTED" };
}
