import type { Artifact, ArtifactField, ArtifactSection, GapEntry, PacketData } from "@/lib/types";

function field(
  machine_key: string,
  display_label: string,
  value: ArtifactField["value"],
  citation_ref: string | null,
  is_attested = true,
): ArtifactField {
  return {
    machine_key,
    display_label,
    value,
    citation_ref,
    is_attested,
  };
}

function section(label: string, fields: ArtifactField[]): ArtifactSection {
  return {
    label,
    fields,
  };
}

const gapIndependentRedTeam: GapEntry = {
  id: "G-01",
  title: "Independent adversarial red-team not yet complete",
  description:
    "ClaraHealth has completed internal prompt-injection and jailbreak testing, but the scheduled external red-team exercise has not yet run against the June 2026 release candidate.",
  remediation:
    "Complete the contracted third-party red-team, document findings, and append the signed report addendum to Artifact 02 before production expansion.",
  owner_name: "Maya Chen",
  owner_title: "Chief Information Security Officer",
  target_date: "2026-07-15",
  compensating_control:
    "High-risk prompts are blocked by policy middleware, privileged tools require human approval, and production traffic is rate-limited with manual escalation.",
};

const gapAccessRecertification: GapEntry = {
  id: "G-02",
  title: "Quarterly break-glass recertification is still manual",
  description:
    "Emergency administrator access exists for incident response, but recertification evidence is maintained in an operations runbook rather than enforced by automated IAM review workflows.",
  remediation:
    "Move the break-glass role into the quarterly access-review campaign and archive reviewer approvals in the packet evidence store.",
  owner_name: "Jordan Lee",
  owner_title: "Staff Security Engineer",
  target_date: "2026-07-01",
  compensating_control:
    "Break-glass access is time-boxed to four hours, paged to security leadership, and reviewed at the next weekly change-control meeting.",
};

const gapDeletionAttestations: GapEntry = {
  id: "G-03",
  title: "Subprocessor deletion attestations are pending for the last retention cycle",
  description:
    "Customer deletion requests are executed in ClaraHealth systems on time, but signed deletion attestations from one analytics subprocessor have not yet been returned for the May cycle.",
  remediation:
    "Collect the missing signed attestations, attach them to the retention packet, and update the subprocessor scorecard with a hard SLA.",
  owner_name: "Elena Park",
  owner_title: "Privacy Program Manager",
  target_date: "2026-06-28",
  compensating_control:
    "Exports to the analytics vendor are tokenized, encrypted, and excluded from new customers until the attestation backlog is cleared.",
};

const gapReleaseDrill: GapEntry = {
  id: "G-04",
  title: "Rollback drill has not been executed on the current model bundle",
  description:
    "Release gating includes a documented rollback path, but the exact rollback drill for the current bundle version has not been rehearsed end to end since the May dependency update.",
  remediation:
    "Run the rollback drill in the staging clone, capture timing and checkpoints, and attach the signed drill record to Artifact 08.",
  owner_name: "Priya Natarajan",
  owner_title: "ML Platform Lead",
  target_date: "2026-06-24",
  compensating_control:
    "Production deployments remain canary-only with a frozen fallback bundle and a manual release commander required for promotion.",
};

const gapEvalCoverage: GapEntry = {
  id: "G-05",
  title: "Shadow-mode evaluation set is below target coverage for oncology denials",
  description:
    "The regression suite covers the top payer workflows, but oncology-denial examples are still below the target sample count required by ClaraHealth's release rubric.",
  remediation:
    "Expand the labeled evaluation set with the queued oncology cases and rerun acceptance thresholds before broader rollout to commercial plans.",
  owner_name: "Ravi Patel",
  owner_title: "Applied AI Lead",
  target_date: "2026-06-30",
  compensating_control:
    "Oncology cases remain in mandatory human-review mode and are excluded from straight-through automation decisions.",
};

const gapAbuseReview: GapEntry = {
  id: "G-06",
  title: "Prompt-abuse taxonomy review is overdue for the current quarter",
  description:
    "Monitoring rules are active, but the formal quarterly review that refreshes abuse patterns, blocked intents, and reviewer guidance has not yet been signed for Q2 2026.",
  remediation:
    "Hold the review with security and clinical-ops leads, publish the updated abuse taxonomy, and attach the sign-off minutes to Artifact 09.",
  owner_name: "Noah Brooks",
  owner_title: "Security Operations Manager",
  target_date: "2026-06-21",
  compensating_control:
    "Existing abuse heuristics, rate limits, and manual analyst review remain active and alert to the on-call security engineer.",
};

const gapDrTabletop: GapEntry = {
  id: "G-07",
  title: "Disaster recovery tabletop with the newest cloud failover path is pending",
  description:
    "The platform meets backup and restore objectives, but the tabletop covering the newly introduced secondary-region inference path has not yet been completed with vendor participation.",
  remediation:
    "Run the multi-party tabletop, document decision owners and communications timing, and store the signed action log in Artifact 10.",
  owner_name: "Sam Rivera",
  owner_title: "Infrastructure Director",
  target_date: "2026-07-08",
  compensating_control:
    "Nightly immutable backups, warm standby services, and manual traffic cutover runbooks are already in place and tested separately.",
};

const gapRegister: GapEntry[] = [
  gapIndependentRedTeam,
  gapAccessRecertification,
  gapDeletionAttestations,
  gapReleaseDrill,
  gapEvalCoverage,
  gapAbuseReview,
  gapDrTabletop,
];

const artifacts: Artifact[] = [
  {
    id: "01",
    title: "Governance, Scope, and Decision Rights",
    status: "attested",
    detachable: false,
    sections: [
      section("System Boundary", [
        field("system_name", "System", "ClaraHealth prior-auth-v2.1", "ART-01-001"),
        field(
          "decision_scope",
          "Decision Scope",
          "Drafts prior-authorization rationale for payer review; no autonomous adjudication.",
          "ART-01-002",
        ),
        field(
          "data_classes",
          "Data Classes",
          "PHI, payer policy text, provider notes, model telemetry.",
          "ART-01-003",
        ),
        field(
          "approval_gate",
          "Production Gate",
          "Security, privacy, clinical ops, and product sign-off required before release.",
          "ART-01-004",
        ),
      ]),
      section("Accountability", [
        field("business_owner", "Business Owner", "Dana Alvarez, VP Revenue Cycle", "ART-01-005"),
        field("security_owner", "Security Owner", "Maya Chen, CISO", "ART-01-006"),
        field("buyer_mode", "Buyer Review Mode", "Conditional approval packet with explicit gaps", "ART-01-007"),
        field(
          "attestation_basis",
          "Attestation Basis",
          "Named owners, cited evidence, and dated remediation commitments.",
          "ART-01-008",
        ),
      ]),
    ],
    gaps: [],
    ciso_simulation: [
      {
        question: "Who can approve a release when buyer review questions change?",
        answer:
          "Only the named product, security, privacy, and clinical owners can approve release scope changes; buyer-specific answers must be attached to this packet before promotion.",
      },
      {
        question: "What does the system do that could affect a member?",
        answer:
          "It drafts support text for prior-auth workflows, but all denials, approvals, and outbound member decisions stay under human review in payer systems.",
      },
    ],
  },
  {
    id: "02",
    title: "Model Inventory and Use Policy Summary",
    status: "attested_with_gaps",
    detachable: false,
    sections: [
      section("Model Inventory", [
        field("primary_model", "Primary Model", "Anthropic Claude 4.1 via managed API", "ART-02-001"),
        field("fallback_model", "Fallback Model", "Vendor-disabled; no automatic fallback in production", "ART-02-002"),
        field(
          "allowed_use",
          "Allowed Use",
          "Summarization, rationale drafting, and citation extraction for prior-auth reviewers.",
          "ART-02-003",
        ),
        field(
          "chai_crosswalk_note",
          "CHAI Note",
          "See the CHAI crosswalk below for buyer-questionnaire field mapping.",
          "ART-02-004",
        ),
      ]),
      section("Policy Controls", [
        field("tool_permissions", "Tool Permissions", "Read-only policy retrieval plus bounded citation lookup", "ART-02-005"),
        field("disallowed_use", "Disallowed Use", "No autonomous approvals, denials, triage, or member messaging", "ART-02-006"),
        field("prompt_change_control", "Prompt Change Control", "Versioned in git with release-board approval", "ART-02-007"),
        field(
          "external_red_team",
          "External Red-Team",
          "Scheduled 2026-07-15; internal suite complete",
          null,
          false,
        ),
      ]),
    ],
    gaps: [gapIndependentRedTeam],
    ciso_simulation: [
      {
        question: "Can the model call tools or external systems without a reviewer?",
        answer:
          "No. The runtime exposes only read-only retrieval for policy context, and every workflow still routes through a human reviewer before downstream payer action.",
      },
      {
        question: "How do you translate this into a buyer questionnaire format?",
        answer:
          "Artifact 02 names the model, permissions, and disallowed uses, and the CHAI crosswalk maps those fields to the question structure many healthcare buyers already use.",
      },
    ],
  },
  {
    id: "03",
    title: "Training Data and Vendor Dependency Disclosure",
    status: "attested",
    detachable: false,
    sections: [
      section("Training and Fine-Tuning", [
        field("customer_training", "Customer Data Used for Training", "No", "ART-03-001"),
        field("fine_tuning", "Fine-Tuning", "No customer-specific fine-tuning in production", "ART-03-002"),
        field("rag_corpus", "Runtime Corpus", "Payer policy documents, implementation runbooks, and approved templates", "ART-03-003"),
        field("data_segregation", "Corpus Segregation", "Customer documents scoped to tenant and reviewer role", "ART-03-004"),
      ]),
      section("Dependencies", [
        field("critical_vendors", "Critical Vendors", "Anthropic API, Vercel hosting, AWS KMS-backed storage", "ART-03-005"),
        field("vendor_review_cycle", "Vendor Review Cycle", "Annual diligence plus material-change review", "ART-03-006"),
        field("residency", "Data Residency", "United States only", "ART-03-007"),
        field("subprocessor_log", "Subprocessor Log", "Versioned register with security and privacy approvals", "ART-03-008"),
      ]),
    ],
    gaps: [],
    ciso_simulation: [
      {
        question: "Do any customer prompts or outputs feed future model training?",
        answer:
          "No. ClaraHealth contractually disables provider training use, limits runtime data to the active workflow, and documents this control in the vendor due-diligence record.",
      },
      {
        question: "How are third-party changes surfaced to buyers?",
        answer:
          "Material dependency changes trigger a vendor review and update to this artifact before the affected release can be promoted.",
      },
    ],
  },
  {
    id: "04",
    title: "Access Control and Tenant Isolation",
    status: "attested_with_gaps",
    detachable: true,
    sections: [
      section("Access Model", [
        field("identity_source", "Identity Source", "SAML SSO with enforced MFA for all workforce users", "ART-04-001"),
        field("role_model", "Role Model", "Least-privilege reviewer, manager, support, and security roles", "ART-04-002"),
        field("tenant_boundary", "Tenant Boundary", "Logical tenant partitioning with policy and record scoping", "ART-04-003"),
        field("session_controls", "Session Controls", "Idle timeout, IP anomaly alerts, and device checks", "ART-04-004"),
      ]),
      section("Privileged Access", [
        field("break_glass_path", "Break-Glass Path", "Time-boxed emergency role with executive notification", "ART-04-005"),
        field("production_access", "Direct Production Access", "Security-engineering only; dual approval required", "ART-04-006"),
        field(
          "recertification_state",
          "Quarterly Recertification",
          "Manual review evidence tracked in ops runbook",
          null,
          false,
        ),
      ]),
    ],
    gaps: [gapAccessRecertification],
    ciso_simulation: [
      {
        question: "If support needs emergency access, what stops it from becoming permanent?",
        answer:
          "Break-glass access is approved separately, expires automatically after four hours, and is reviewed in the next weekly control meeting with security leadership.",
      },
      {
        question: "Can one tenant ever retrieve another tenant's packet inputs?",
        answer:
          "No. Tenant identifiers scope retrieval, document access, and export jobs, and those boundaries are covered in application tests and release review.",
      },
    ],
  },
  {
    id: "05",
    title: "PHI Handling, Retention, and Deletion",
    status: "attested_with_gaps",
    detachable: true,
    sections: [
      section("PHI Controls", [
        field("ingress_channel", "Ingress Channel", "Encrypted upload or API ingestion under signed BAA", "ART-05-001"),
        field("storage_encryption", "Storage Encryption", "AES-256 at rest with cloud KMS-managed keys", "ART-05-002"),
        field("transport_encryption", "Transport Encryption", "TLS 1.2+ for all external and internal service hops", "ART-05-003"),
        field("minimum_necessary", "Minimum Necessary", "Only fields required for review drafting are retained in the working set", "ART-05-004"),
      ]),
      section("Retention and Deletion", [
        field("default_retention", "Default Retention", "30 days unless contract requires shorter retention", "ART-05-005"),
        field("deletion_sla", "Deletion SLA", "Seven calendar days after verified request or contract termination", "ART-05-006"),
        field("backup_window", "Backup Window", "Immutable backups retained for 35 days", "ART-05-007"),
        field(
          "subprocessor_attestations",
          "Subprocessor Deletion Attestations",
          "Pending for the last analytics cycle",
          null,
          false,
        ),
      ]),
    ],
    gaps: [gapDeletionAttestations],
    ciso_simulation: [
      {
        question: "What happens to PHI after a packet is delivered?",
        answer:
          "Working data is retained only for the contracted window, deleted on the defined SLA, and customer exports are logged so the buyer can audit what was generated.",
      },
      {
        question: "How do you handle deletion evidence from subprocessors?",
        answer:
          "The primary systems delete on time today; the current gap is collecting the signed attestation from one subprocessor so the evidence chain is complete.",
      },
    ],
  },
  {
    id: "07",
    title: "Human Review and Override Controls",
    status: "attested",
    detachable: false,
    sections: [
      section("Review Gates", [
        field("human_required", "Human Required Before Submission", "Yes, for every buyer-facing packet and authorization draft", "ART-07-001"),
        field("clinical_queue", "Clinical Escalation Queue", "Required for contraindications, oncology, and pediatric edge cases", "ART-07-002"),
        field("override_mechanism", "Override Mechanism", "Reviewers can reject or fully rewrite generated output", "ART-07-003"),
        field("training_requirement", "Reviewer Training", "Initial onboarding plus annual refresh with signed attestation", "ART-07-004"),
      ]),
      section("Auditability", [
        field("decision_log", "Decision Log", "Reviewer identity, timestamp, and final disposition captured", "ART-07-005"),
        field("sampling", "Quality Sampling", "Weekly QA review of approved and rejected drafts", "ART-07-006"),
        field("escalation_sla", "Escalation SLA", "Security or clinical escalation within one business hour", "ART-07-007"),
      ]),
    ],
    gaps: [],
    ciso_simulation: [
      {
        question: "What stops generated text from reaching a payer untouched?",
        answer:
          "The workflow enforces human review and logs the reviewer who accepted, edited, or rejected the draft before anything leaves the platform.",
      },
      {
        question: "How do you handle unsafe medical nuance?",
        answer:
          "High-risk categories route to mandatory clinical escalation and cannot be cleared by a non-clinical reviewer.",
      },
    ],
  },
  {
    id: "06",
    title: "Prompt, Policy, and Tooling Guardrails",
    status: "attested",
    detachable: false,
    sections: [
      section("Prompt Controls", [
        field("system_prompt_source", "System Prompt Source", "Versioned repository with protected branches", "ART-06-001"),
        field("prompt_review", "Prompt Review", "Security and product review required for policy changes", "ART-06-002"),
        field("jailbreak_filters", "Jailbreak Filters", "Pre- and post-generation policy checks with deny rules", "ART-06-003"),
        field("output_validation", "Output Validation", "Schema checks plus citation-presence validation", "ART-06-004"),
      ]),
      section("Tool Boundaries", [
        field("tool_allowlist", "Tool Allowlist", "Read-only retrieval and packet export only", "ART-06-005"),
        field("network_egress", "Model Runtime Egress", "No arbitrary egress from runtime sandbox", "ART-06-006"),
        field("secret_handling", "Secret Handling", "Server-side secret store only; none exposed in buyer packet pages", "ART-06-007"),
      ]),
    ],
    gaps: [],
    ciso_simulation: [
      {
        question: "Can a prompt injection make the system call an unapproved tool?",
        answer:
          "No. Tool access is allowlisted at the runtime boundary, and the model has no authority to create new actions outside that contract.",
      },
      {
        question: "How are prompt changes kept from drifting quietly over time?",
        answer:
          "Prompts are versioned in git, reviewed like code, and tied to release approvals so the exact prompt set is attributable to each packet version.",
      },
    ],
  },
  {
    id: "11",
    title: "Incident Response and Security Operations",
    status: "attested",
    detachable: false,
    sections: [
      section("Detection and Response", [
        field("siem_pipeline", "SIEM Pipeline", "Auth, admin, packet export, and model safety events stream to SIEM", "ART-11-001"),
        field("on_call", "On-Call Coverage", "24x7 security and infrastructure rotation", "ART-11-002"),
        field("triage_playbook", "Triage Playbook", "Severity matrix with named incident commander and comms owner", "ART-11-003"),
        field("buyer_notice", "Buyer Notice SLA", "Initial notice within 24 hours for confirmed material incidents", "ART-11-004"),
      ]),
      section("Preparedness", [
        field("tabletop_cadence", "Security Tabletop Cadence", "Semiannual cross-functional tabletop exercises", "ART-11-005"),
        field("forensics", "Forensic Retention", "Relevant logs preserved for at least 12 months", "ART-11-006"),
        field("lessons_learned", "Post-Incident Review", "Written review with tracked action items and owners", "ART-11-007"),
      ]),
    ],
    gaps: [],
    ciso_simulation: [
      {
        question: "What does a buyer get if there is a confirmed security incident?",
        answer:
          "Buyers receive the initial notice within the contractual window, the scoped impact summary, containment actions, and the named follow-up owner from incident command.",
      },
      {
        question: "Are AI-specific alerts separate from standard SaaS alerts?",
        answer:
          "Yes. Abuse, policy-violation, export, and model-guardrail events are tagged separately so the responder can isolate AI workflow issues quickly.",
      },
    ],
  },
  {
    id: "08",
    title: "Evaluation, Release Approval, and Rollback",
    status: "attested_with_gaps",
    detachable: true,
    sections: [
      section("Release Gates", [
        field("eval_suite", "Evaluation Suite", "Regression, prompt-injection, hallucination, and citation-presence checks", "ART-08-001"),
        field("release_board", "Release Board", "Product, security, clinical ops, and platform engineering", "ART-08-002"),
        field("canary_rollout", "Rollout Pattern", "Canary release before full traffic promotion", "ART-08-003"),
        field("rollback_bundle", "Rollback Bundle", "Last-known-good model bundle pinned and retained", "ART-08-004"),
      ]),
      section("Open Release Gaps", [
        field("rollback_drill_status", "Rollback Drill", "Pending for current bundle", null, false),
        field("oncology_eval_status", "Oncology Eval Coverage", "Below target sample count; gated behind human review", null, false),
      ]),
    ],
    gaps: [gapReleaseDrill, gapEvalCoverage],
    ciso_simulation: [
      {
        question: "If the new bundle regresses, how fast can you unwind it?",
        answer:
          "The previous signed bundle stays pinned and ready; the remaining gap is rehearsing the exact rollback on the June bundle so the timing evidence is fresh.",
      },
      {
        question: "Why release at all if oncology coverage is incomplete?",
        answer:
          "Because the affected workflow remains in mandatory human review, and broader rollout is blocked until the evaluation set reaches the defined threshold.",
      },
    ],
  },
  {
    id: "09",
    title: "Monitoring, Logging, and Abuse Detection",
    status: "attested_with_gaps",
    detachable: false,
    sections: [
      section("Operational Logging", [
        field("event_types", "Event Types", "Prompt metadata, tool calls, reviewer actions, exports, and admin changes", "ART-09-001"),
        field("log_redaction", "Log Redaction", "PHI minimized and tokenized before long-term storage", "ART-09-002"),
        field("retention_period", "Retention Period", "365 days online, 18 months archived", "ART-09-003"),
        field("alerting_path", "Alerting Path", "Pager-triggered alerts with analyst follow-up in SIEM", "ART-09-004"),
      ]),
      section("Abuse Controls", [
        field("abuse_heuristics", "Abuse Heuristics", "Prompt-injection, credential capture, policy circumvention, and data exfiltration patterns", "ART-09-005"),
        field("rate_limit", "Rate Limits", "Per-tenant throttles plus anomaly-based lockouts", "ART-09-006"),
        field("taxonomy_review", "Quarterly Taxonomy Review", "Overdue for Q2 2026 sign-off", null, false),
      ]),
    ],
    gaps: [gapAbuseReview],
    ciso_simulation: [
      {
        question: "What gets logged when a suspicious prompt arrives?",
        answer:
          "The system records the request metadata, triggered guardrails, blocked tools, reviewer actions, and the final disposition so investigators can reconstruct the event.",
      },
      {
        question: "How do you keep abuse rules current as attacker patterns shift?",
        answer:
          "The heuristics are live today; the current open item is the formal quarterly review and sign-off for the refreshed taxonomy.",
      },
    ],
  },
  {
    id: "10",
    title: "Business Continuity and Disaster Recovery",
    status: "attested_with_gaps",
    detachable: false,
    sections: [
      section("Recovery Objectives", [
        field("rto", "RTO", "Four hours", "ART-10-001"),
        field("rpo", "RPO", "Fifteen minutes", "ART-10-002"),
        field("backup_model", "Backup Model", "Nightly immutable backups plus hourly database snapshots", "ART-10-003"),
        field("failover_path", "Failover Path", "Warm secondary region with manual traffic cutover", "ART-10-004"),
      ]),
      section("Preparedness", [
        field("restore_testing", "Restore Testing", "Quarterly backup restore validation complete", "ART-10-005"),
        field("vendor_dependencies", "Vendor Dependencies", "Critical vendors participate in annual resilience review", "ART-10-006"),
        field("secondary_region_tabletop", "Secondary-Region Tabletop", "Pending with newest failover path", null, false),
      ]),
    ],
    gaps: [gapDrTabletop],
    ciso_simulation: [
      {
        question: "What evidence do you have that you can recover the service?",
        answer:
          "Backups, restore tests, and the failover runbook are complete; the only open item is the joint tabletop on the new secondary-region path so the communications chain is current.",
      },
      {
        question: "What is the buyer impact if failover is needed?",
        answer:
          "Packet review remains available from the warm standby, with manual traffic cutover and predefined buyer communications led by the infrastructure director.",
      },
    ],
  },
  {
    id: "12",
    title: "Buyer Handoff and Verification Bundle",
    status: "attested",
    detachable: true,
    sections: [
      section("Verification Assets", [
        field("packet_id", "Packet ID", "sample-health-001", "ART-12-001"),
        field("packet_json_path", "packet.json", "/p/sample-health-001/packet.json", "ART-12-002"),
        field("verify_script_path", "verify.sh", "/p/sample-health-001/verify.sh", "ART-12-003"),
        field("export_mode", "Export Mode", "Static export; buyer-downloadable with stable hash", "ART-12-004"),
      ]),
      section("Handoff Controls", [
        field("handoff_owner", "Handoff Owner", "Maya Chen, CISO", "ART-12-005"),
        field("buyer_contact", "Buyer Contact", "security-review@northwindhealth.example", "ART-12-006"),
        field("format_standard", "Format Standard", "AERF-compatible evidence packet", "ART-12-007"),
        field("approval_route", "Approval Route", "Packet hash, attestation, and footer all reference the same build artifact", "ART-12-008"),
      ]),
    ],
    gaps: [],
    ciso_simulation: [
      {
        question: "How does a buyer know the downloaded JSON is the same packet you signed?",
        answer:
          "The cover, verification section, footer, and verify.sh script all point back to the same packet hash generated from the canonical packet JSON.",
      },
      {
        question: "Can the packet be forwarded outside the main page?",
        answer:
          "Yes. Artifact 12 is detachable, and the verification bundle is self-contained for buyer security reviewers who only need the attested export assets.",
      },
    ],
  },
];

export const claraHealthPacket: PacketData = {
  metadata: {
    packet_id: "sample-health-001",
    vendor: "ClaraHealth",
    jurisdiction: "United States",
    system: "prior-auth-v2.1",
    version: "2.1.0",
    workflow: "AI-assisted prior authorization drafting for healthcare revenue-cycle teams",
    regulatory_classification: "HIPAA-covered healthcare SaaS operating under BAAs",
    buyer: "Northwind Health Plan",
    generated_at: "2026-06-10T14:12:00Z",
    methodology_version: "AERF 0.3 / AgentMint packet rubric 2026-06",
    attested_by_name: "Maya Chen",
    attested_by_title: "Chief Information Security Officer",
  },
  executive_summary: {
    system_description:
      "ClaraHealth prior-auth-v2.1 drafts payer-facing prior-authorization rationale for healthcare revenue-cycle teams. The system retrieves plan policies, structures reviewer notes, and produces a cited draft for human approval; it does not autonomously approve, deny, or transmit payer decisions.",
    status_line:
      "Twelve attested artifacts are included. Seven open gaps remain, each explicitly owned, dated, and bounded by a compensating control that is live today.",
    top_gaps: [
      "G-01 - External adversarial red-team is scheduled but not yet complete.",
      "G-04 - Current-bundle rollback drill has not been rehearsed end to end.",
      "G-05 - Oncology shadow-mode evaluation coverage is below target and remains gated behind human review.",
    ],
    deal_context:
      "Prepared for a healthcare-plan security review where the buyer requested AI-specific evidence beyond SOC 2 and standard vendor due-diligence materials.",
    contact: "Packet owner: security@clarahealth.example",
  },
  artifacts,
  gap_register: gapRegister,
  attestation: {
    statement:
      "I attest that this packet accurately describes ClaraHealth prior-auth-v2.1 as deployed for buyer review on June 10, 2026; cited controls are implemented as stated, and every known material gap is explicitly disclosed with an owner, target date, and compensating control.",
    explicit_non_claims: [
      "This packet does not claim that the model is error-free or clinically deterministic.",
      "This packet does not replace buyer-specific legal, privacy, or procurement review.",
      "This packet does not claim autonomous decision-making authority for claims approval or denial.",
    ],
    signed_date: "2026-06-10",
  },
  owasp_llm_assessment: [
    {
      threat_id: "LLM01",
      threat: "Prompt Injection",
      control: "Guardrails, tool allowlists, and human review before any buyer-facing action.",
      status: "Controlled",
    },
    {
      threat_id: "LLM02",
      threat: "Insecure Output Handling",
      control: "Schema validation, citation checks, and reviewer approval before export.",
      status: "Controlled",
    },
    {
      threat_id: "LLM03",
      threat: "Training Data Poisoning",
      control: "No customer-data training and versioned runtime corpus approvals.",
      status: "Controlled",
    },
    {
      threat_id: "LLM04",
      threat: "Model Denial of Service",
      control: "Per-tenant throttles, queue controls, and operational fallback to manual review.",
      status: "Controlled",
    },
    {
      threat_id: "LLM05",
      threat: "Supply Chain Vulnerabilities",
      control: "Annual vendor diligence plus material-change review for core providers.",
      status: "Controlled",
    },
    {
      threat_id: "LLM06",
      threat: "Sensitive Information Disclosure",
      control: "PHI minimization, encryption, retention controls, and deletion workflows.",
      status: "Gap owned",
    },
    {
      threat_id: "LLM07",
      threat: "Insecure Plugin Design",
      control: "Read-only retrieval tools only; no arbitrary plugin execution.",
      status: "Controlled",
    },
    {
      threat_id: "LLM08",
      threat: "Excessive Agency",
      control: "No autonomous approvals, denials, or external submissions.",
      status: "Controlled",
    },
    {
      threat_id: "LLM09",
      threat: "Overreliance",
      control: "Mandatory human review, clinical escalation queues, and quality sampling.",
      status: "Controlled",
    },
    {
      threat_id: "LLM10",
      threat: "Model Theft",
      control: "Vendor-managed API, secret isolation, and restricted runtime egress.",
      status: "Controlled",
    },
  ],
  chai_crosswalk: [
    {
      chai_field: "System purpose and intended use",
      packet_location: "Artifact 01 -> System Boundary -> Decision Scope",
    },
    {
      chai_field: "Model inventory and provider",
      packet_location: "Artifact 02 -> Model Inventory -> Primary Model",
    },
    {
      chai_field: "Training data and data use disclosures",
      packet_location: "Artifact 03 -> Training and Fine-Tuning",
    },
    {
      chai_field: "Identity, access, and tenant isolation controls",
      packet_location: "Artifact 04 -> Access Model / Privileged Access",
    },
    {
      chai_field: "PHI handling, retention, and deletion",
      packet_location: "Artifact 05 -> PHI Controls / Retention and Deletion",
    },
    {
      chai_field: "Human oversight and override capability",
      packet_location: "Artifact 07 -> Review Gates / Auditability",
    },
    {
      chai_field: "Evaluation, monitoring, and safety testing",
      packet_location: "Artifacts 08 and 09 -> Release Gates / Abuse Controls",
    },
    {
      chai_field: "Incident response, continuity, and buyer verification",
      packet_location: "Artifacts 11, 10, and 12 -> Detection / Recovery / Verification Assets",
    },
  ],
};

export default claraHealthPacket;
