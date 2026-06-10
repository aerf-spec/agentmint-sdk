import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HashDisplay } from "@/components/ui/HashDisplay";
import { MonoLabel } from "@/components/ui/MonoLabel";
import { SerifBody } from "@/components/ui/SerifBody";
import { SignedStamp } from "@/components/ui/SignedStamp";
import { StatusPill } from "@/components/ui/StatusPill";

describe("ui components", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("renders MonoLabel and SerifBody with and without custom classes", () => {
    const { rerender } = render(<MonoLabel>Label</MonoLabel>);
    expect(screen.getByText("Label")).toHaveClass("section-label");

    rerender(<MonoLabel className="extra">Label</MonoLabel>);
    expect(screen.getByText("Label")).toHaveClass("section-label", "extra");

    rerender(<SerifBody>Body</SerifBody>);
    expect(screen.getByText("Body")).toHaveClass("section-body");

    rerender(<SerifBody className="extra-body">Body</SerifBody>);
    expect(screen.getByText("Body")).toHaveClass("section-body", "extra-body");
  });

  it("renders SignedStamp and every StatusPill variant", () => {
    render(
      <>
        <SignedStamp date="2026-06-09" />
        <StatusPill status="attested" />
        <StatusPill status="attested_with_gaps" />
        <StatusPill status="gap" />
        <StatusPill status="sample" />
      </>,
    );

    expect(screen.getByText("Signed 2026-06-09")).toHaveClass("signed-stamp");
    expect(screen.getByText("ATTESTED")).toBeInTheDocument();
    expect(screen.getByText("ATTESTED WITH GAPS")).toBeInTheDocument();
    expect(screen.getByText("GAP")).toBeInTheDocument();
    expect(screen.getByText("SAMPLE")).toBeInTheDocument();
  });

  it("renders full and shortened hashes", () => {
    const hash = "1234567890abcdef1234567890abcdef12345678";
    const { rerender } = render(<HashDisplay hash={hash} />);

    expect(screen.getByText(hash)).toBeInTheDocument();

    rerender(<HashDisplay hash={hash} short />);
    expect(screen.getByText("1234567890ab...345678")).toBeInTheDocument();

    rerender(<HashDisplay hash="short-hash" short />);
    expect(screen.getByText("short-hash")).toBeInTheDocument();
  });

  it("copies the hash and resets the label, clearing previous timers on repeated copies", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const clearTimeoutSpy = vi.spyOn(window, "clearTimeout");
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    render(<HashDisplay hash="abc123" />);
    const button = screen.getByRole("button", { name: "Copy Hash" });

    fireEvent.click(button);
    await act(async () => {
      await Promise.resolve();
    });
    expect(writeText).toHaveBeenCalledWith("abc123");
    expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Copied" }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(clearTimeoutSpy).toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1200);
    });
    expect(screen.getByRole("button", { name: "Copy Hash" })).toBeInTheDocument();
  });

  it("handles clipboard failures and clears pending timers on unmount", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: vi.fn().mockRejectedValue(new Error("nope")),
      },
    });
    const clearTimeoutSpy = vi.spyOn(window, "clearTimeout");

    const firstRender = render(<HashDisplay hash="abc123" />);

    fireEvent.click(screen.getByRole("button", { name: "Copy Hash" }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByRole("button", { name: "Copy Hash" })).toBeInTheDocument();

    firstRender.unmount();
    expect(clearTimeoutSpy).not.toHaveBeenCalled();

    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    });

    const secondRender = render(<HashDisplay hash="abc123" />);
    fireEvent.click(screen.getByRole("button", { name: "Copy Hash" }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();
    secondRender.unmount();
    expect(clearTimeoutSpy).toHaveBeenCalled();
  });
});
