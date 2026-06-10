"use client";

import { useState } from "react";

import type { CisoSimEntry } from "@/lib/types";

type PacketAccordionProps = {
  entries: CisoSimEntry[];
};

export function PacketAccordion({ entries }: PacketAccordionProps) {
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  if (entries.length === 0) {
    return null;
  }

  return (
    <div className="faq-list">
      {entries.map((entry, index) => {
        const isOpen = openIndex === index;

        return (
          <article key={`${entry.question}-${index}`} className="faq-item" data-open={isOpen}>
            <button
              type="button"
              className="faq-toggle"
              onClick={() => setOpenIndex(isOpen ? null : index)}
              aria-expanded={isOpen}
            >
              <span className="faq-question">{entry.question}</span>
              <span className="faq-toggle__meta">
                <span className="faq-toggle__label sr-only">{isOpen ? "Hide" : "Show"}</span>
                <span className="faq-toggle__icon" aria-hidden="true">
                  +
                </span>
              </span>
            </button>
            <p className="faq-answer" data-visible={isOpen}>
              {entry.answer}
            </p>
          </article>
        );
      })}
    </div>
  );
}
