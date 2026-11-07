import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MandateLogo, MandateMark, mandateMarkSvg } from "@/components/brand/MandateLogo";

describe("MandateMark", () => {
  it("renders the four rising bars, labelled Mandate", () => {
    const html = renderToStaticMarkup(<MandateMark />);
    expect(html).toContain('aria-label="Mandate"');
    expect((html.match(/<rect/g) ?? []).length).toBe(4);
  });

  it("tile variant adds a solid rounded square behind the bars, never a gradient", () => {
    const html = renderToStaticMarkup(<MandateMark variant="tile" />);
    expect(html).not.toContain("linearGradient");
    expect(html).toContain('rx="14"');
    // 4 bars + the background square = 5 rects.
    expect((html.match(/<rect/g) ?? []).length).toBe(5);
  });

  it("flat variant uses currentColor and no background tile", () => {
    const html = renderToStaticMarkup(<MandateMark variant="flat" />);
    expect(html).toContain("currentColor");
    expect(html).not.toContain("linearGradient");
  });
});

describe("MandateLogo", () => {
  it("renders the flat mark and, by default, the Mandate wordmark", () => {
    const html = renderToStaticMarkup(<MandateLogo />);
    expect(html).toContain("Mandate");
    expect(html).toContain("currentColor");
    expect((html.match(/<rect/g) ?? []).length).toBe(4);
  });

  it("omits the wordmark when withWordmark is false", () => {
    const html = renderToStaticMarkup(<MandateLogo withWordmark={false} />);
    expect(html).not.toContain(">Mandate<");
  });
});

describe("mandateMarkSvg", () => {
  it("returns a self-contained SVG string with the four bars", () => {
    const svg = mandateMarkSvg(18);
    expect(svg).toContain("<svg");
    expect(svg).toContain('width="18"');
    expect(svg).not.toContain("linearGradient");
    expect((svg.match(/<rect/g) ?? []).length).toBe(4);
  });
});
