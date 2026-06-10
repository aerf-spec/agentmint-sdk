import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/home/SectionObserver", () => ({
  SectionObserver: () => null,
}));

describe("HomePage", () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.TALLY_FORM_URL;
    delete process.env.STRIPE_STANDARD;
    delete process.env.STRIPE_URGENT;
    delete process.env.NEXT_PUBLIC_CALENDAR_URL;
  });

  afterEach(() => {
    cleanup();
  });

  it("renders the procurement-focused homepage with the fallback intake email", async () => {
    const module = await import("@/app/page");
    const HomePage = module.default;

    render(<HomePage />);

    expect(screen.getAllByRole("link", { name: "AgentMint" }).length).toBe(2);
    expect(screen.getByRole("heading", { name: /Squash procurement/i })).toBeInTheDocument();
    expect(screen.getByText(/Your deal is in InfoSec review/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /See a sample packet/i })).toHaveAttribute(
      "href",
      "/p/sample-health-001",
    );
    expect(
      screen.getByRole("link", { name: /Email your questionnaire to aniketh@agentmint.run/i }),
    ).toHaveAttribute("href", "mailto:aniketh@agentmint.run");
    expect(screen.getByRole("link", { name: /Reserve urgent sprint/i })).toHaveAttribute(
      "href",
      "mailto:aniketh@agentmint.run?subject=Urgent%20Sprint",
    );
  });

  it("renders the intake iframe, calendar link, and stripe links when build env is present", async () => {
    process.env.TALLY_FORM_URL = "https://tally.so/example";
    process.env.STRIPE_STANDARD = "https://checkout.stripe.com/example";
    process.env.STRIPE_URGENT = "https://checkout.stripe.com/urgent";
    process.env.NEXT_PUBLIC_CALENDAR_URL = "https://calendar.example.com/agentmint";

    const module = await import("@/app/page");
    const HomePage = module.default;

    render(<HomePage />);

    expect(screen.getByTitle("Questionnaire intake form")).toHaveAttribute(
      "src",
      "https://tally.so/example",
    );
    expect(screen.getByRole("link", { name: /Book a 15-minute scoping call/i })).toHaveAttribute(
      "href",
      "https://calendar.example.com/agentmint",
    );
    expect(screen.getByRole("link", { name: /Reserve standard sprint/i })).toHaveAttribute(
      "href",
      "https://checkout.stripe.com/example",
    );
    expect(screen.getByRole("link", { name: /Reserve urgent sprint/i })).toHaveAttribute(
      "href",
      "https://checkout.stripe.com/urgent",
    );
  });
});
