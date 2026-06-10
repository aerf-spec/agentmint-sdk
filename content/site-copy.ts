export const siteCopy = {
  home: {
    nav: {
      ctaAriaLabel: "Send your questionnaire",
      ctaFull: "Send your questionnaire →",
      ctaShort: "Send questionnaire →",
    },
    hero: {
      eyebrow: "AI VENDOR PROCUREMENT · HEALTHCARE RCM",
      headlineMono: "Squash",
      headlineSerif: "procurement.",
      subhead:
        "Your deal is in InfoSec review. The CISO sent follow-up questions you can't answer. This is the packet that gets it out.",
      support:
        "Your SOC 2 doesn't cover the AI block. These questions require evidence that doesn't exist yet — we produce it in 48 hours, attested under your name.",
      primaryCta: "Send your questionnaire →",
      secondaryCta: "See a sample packet →",
      footnote: "$3,500 standard · $7,500 urgent · paid before kickoff · 48-hour delivery",
    },
    credential: {
      body:
        "Six years at Capital One reviewing AI vendors from the buyer side. I led API security controls, built ML fraud detection at 10,000 TPS, and got Google Vertex AI through C1's approval a year ahead of schedule. I know what a health plan CISO needs to see.",
      byline: "Aniketh Maddipati, founder · ex-Capital One · NYC",
    },
    steps: {
      label: "How It Works",
      items: [
        {
          number: "01",
          day: "DAY 0",
          title: "Send the questionnaire",
          body:
            "Forward your buyer's security questionnaire. We isolate the AI-specific block within hours.",
        },
        {
          number: "02",
          day: "DAY 1",
          title: "Answer 18 questions",
          body:
            "We draft from your evidence; you answer only what no document can — owners, dates, mechanisms.",
        },
        {
          number: "03",
          day: "DAY 2",
          title: "Attest and submit",
          body:
            "Twelve artifacts, honest gap register, hash-verified. You sign it; your buyer's review proceeds.",
        },
      ],
    },
    intake: {
      label: "SEND YOUR QUESTIONNAIRE",
      intro: "We review every submission personally and respond within 24 hours.",
      calendarCta: "Book a 15-minute scoping call →",
      mailtoLabel: "Email your questionnaire to aniketh@agentmint.run",
      offers: {
        designPartner: {
          kicker: "DESIGN PARTNER",
          pill: "2 SLOTS",
          title: "No cost — real stalled deals only; you become a reference",
          cta: "Apply by email →",
        },
        standard: {
          kicker: "STANDARD SPRINT",
          price: "$3,500",
          body: "One agent · one questionnaire · 48-hour delivery",
          cta: "Reserve standard sprint →",
        },
        urgent: {
          kicker: "URGENT SPRINT",
          price: "$7,500",
          body: "Buyer deadline this week · expedited review and delivery",
          cta: "Reserve urgent sprint →",
        },
      },
    },
    footer: {
      standardLinkLabel: "AERF",
      tag: "Making AI agents procurement-ready.",
    },
  },
  packet: {
    metadata: {
      title: "ClaraHealth prior-auth-v2.1 — AI Vendor Evidence Packet (sample)",
      description:
        "Twelve attested AI governance artifacts in the format health plan security reviews consume.",
    },
    nav: {
      verifyLabel: "Verify",
    },
    sampleBanner:
      "SAMPLE — ClaraHealth is fictional. Format, field depth, and gap handling are exactly what attested packets contain.",
    artifactsLabel: "AI VENDOR EVIDENCE ARTIFACTS",
    exit: {
      copy: "Your agent needs one of these. Send us your questionnaire →",
      cta: "Send us your questionnaire →",
    },
    footer: {
      standardLabel: "Evidence format: AERF, an open standard",
    },
  },
} as const;
