import { useEffect, useRef, useState } from "react";
import gsap from "gsap";
import { usePrefersReducedMotion } from "../hooks/useTheme.js";

// react-bits-style animated number: eases from 0 to `value` on mount. The
// `format` fn runs on every frame, so byte sizes roll through their units too.
export default function CountUp({ value, format = (n) => Math.round(n).toLocaleString(), duration = 1.1, className }) {
  const reduced = usePrefersReducedMotion();
  const [display, setDisplay] = useState(value);
  const started = useRef(false);

  useEffect(() => {
    if (reduced) {
      setDisplay(value);
      return;
    }
    const obj = { n: started.current ? value : 0 };
    started.current = true;
    const tween = gsap.to(obj, {
      n: value,
      duration,
      ease: "power2.out",
      onUpdate: () => setDisplay(obj.n),
    });
    return () => tween.kill();
  }, [value, reduced, duration]);

  return <span className={className}>{format(display)}</span>;
}
