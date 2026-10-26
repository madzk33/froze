import { useEffect, useRef } from "react";
import { useIsDark, usePrefersReducedMotion } from "../hooks/useTheme.js";

// Theme-matched palette for the WebGL "network" field. The network motif is a
// deliberate nod to what the tool does — crawling the connected graph of a site.
const THEMES = {
  light: { color: 0x149e95, backgroundColor: 0xf3f5f7, points: 9, maxDistance: 20, spacing: 20 },
  dark: { color: 0x4ad6c6, backgroundColor: 0x11151b, points: 10, maxDistance: 21, spacing: 18 },
};

export default function VantaBackground() {
  const ref = useRef(null);
  const isDark = useIsDark();
  const reduced = usePrefersReducedMotion();

  useEffect(() => {
    // Respect reduced-motion: no WebGL at all — the static background + hero
    // glow carry the design instead.
    if (reduced || !ref.current) return;

    let effect;
    let cancelled = false;

    // Lazy-load three + vanta so the ~600KB WebGL stack never touches the
    // initial bundle; it streams in after first paint, only when it'll be used.
    (async () => {
      const [THREE, { default: NET }] = await Promise.all([
        import("three"),
        import("vanta/dist/vanta.net.min"),
      ]);
      if (cancelled || !ref.current) return;
      const t = THEMES[isDark ? "dark" : "light"];
      effect = NET({
        el: ref.current,
        THREE,
        mouseControls: true,
        touchControls: true,
        gyroControls: false,
        minHeight: 200,
        minWidth: 200,
        scale: 1,
        scaleMobile: 1,
        color: t.color,
        backgroundColor: t.backgroundColor,
        points: t.points,
        maxDistance: t.maxDistance,
        spacing: t.spacing,
        showDots: true,
      });
    })();

    return () => {
      cancelled = true;
      try {
        effect?.destroy();
      } catch {
        /* ignore */
      }
    };
  }, [isDark, reduced]);

  return (
    <div
      ref={ref}
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 z-0"
      // A soft top-down fade keeps the network subtle and the content readable.
      style={{
        maskImage: "linear-gradient(to bottom, black 0%, black 36%, transparent 72%)",
        WebkitMaskImage: "linear-gradient(to bottom, black 0%, black 36%, transparent 72%)",
        opacity: 0.55,
      }}
    />
  );
}
