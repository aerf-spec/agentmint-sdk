import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/fonts", () => ({
  mono: { variable: "mono-font" },
  serif: { variable: "serif-font" },
}));

describe("RootLayout", () => {
  it("renders the shell, decorative layers, and html font classes", async () => {
    const module = await import("@/app/layout");
    const RootLayout = module.default;

    const markup = renderToStaticMarkup(
      <RootLayout>
        <div>Child content</div>
      </RootLayout>,
    );

    expect(module.metadata.title).toBe("AgentMint");
    expect(module.metadata.description).toContain("Workflow-to-deployment");
    expect(markup).toContain('class="mono-font serif-font"');
    expect(markup).toContain('class="dot-grid"');
    expect(markup).toContain('class="hero-gradient"');
    expect(markup).toContain("Child content");
  });
});
