import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SectionObserver } from "@/components/home/SectionObserver";

type ObservedRecord = {
  observe: ReturnType<typeof vi.fn>;
  unobserve: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  callback: IntersectionObserverCallback;
};

describe("SectionObserver", () => {
  const originalMatchMedia = window.matchMedia;
  const originalIntersectionObserver = window.IntersectionObserver;

  beforeEach(() => {
    document.body.innerHTML = "";
  });

  afterEach(() => {
    cleanup();
    window.matchMedia = originalMatchMedia;
    window.IntersectionObserver = originalIntersectionObserver;
    vi.restoreAllMocks();
  });

  it("marks all matching sections visible immediately for reduced motion", () => {
    const sectionA = document.createElement("section");
    const sectionB = document.createElement("section");
    sectionA.className = "reveal";
    sectionB.className = "reveal";
    document.body.append(sectionA, sectionB);

    window.matchMedia = vi.fn().mockReturnValue({ matches: true }) as typeof window.matchMedia;

    render(<SectionObserver selector=".reveal" />);

    expect(sectionA).toHaveClass("visible");
    expect(sectionB).toHaveClass("visible");
  });

  it("observes matching sections, reveals intersecting entries, and disconnects on cleanup", () => {
    const section = document.createElement("section");
    section.className = "observe-me";
    document.body.append(section);

    const record: ObservedRecord = {
      observe: vi.fn(),
      unobserve: vi.fn(),
      disconnect: vi.fn(),
      callback: () => undefined,
    };

    window.matchMedia = vi.fn().mockReturnValue({ matches: false }) as typeof window.matchMedia;
    window.IntersectionObserver = vi.fn().mockImplementation((callback: IntersectionObserverCallback) => {
      record.callback = callback;

      return {
        observe: record.observe,
        unobserve: record.unobserve,
        disconnect: record.disconnect,
      };
    }) as typeof window.IntersectionObserver;

    const view = render(<SectionObserver selector=".observe-me" />);

    expect(record.observe).toHaveBeenCalledWith(section);

    record.callback(
      [
        {
          isIntersecting: true,
          target: section,
        } as unknown as IntersectionObserverEntry,
      ],
      {} as IntersectionObserver,
    );

    expect(section).toHaveClass("visible");
    expect(record.unobserve).toHaveBeenCalledWith(section);

    view.unmount();

    expect(record.disconnect).toHaveBeenCalled();
  });
});
