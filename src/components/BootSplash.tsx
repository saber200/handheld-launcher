import { useLayoutEffect, useRef, type AnimationEvent } from "react";
import { text } from "../i18n";

type Props = {
  playing: boolean;
  onDone: () => void;
};

function bootGlyphs(value: string, start: number, step: number) {
  return Array.from(value).map((glyph, index) => (
    <span key={index} className="boot-char" style={{ animationDelay: `${start + index * step}s` }}>
      {glyph === " " ? "\u00a0" : glyph}
    </span>
  ));
}

export function BootSplash({ playing, onDone }: Props) {
  const copy = text();
  const rootRef = useRef<HTMLDivElement>(null);
  const title = Array.from(copy.productName);
  const tag = Array.from(copy.about);
  const titleStep = 0.14;
  const tagStart = 4.15 + Math.max(title.length - 1, 0) * titleStep + 0.28;
  const tagStep = Math.min(0.11, 1.1 / Math.max(tag.length, 1));

  useLayoutEffect(() => {
    if (!playing) return;
    const root = rootRef.current;
    const slot = root?.querySelector(".boot-slot");
    if (!root || !(slot instanceof HTMLElement)) return;
    const rect = slot.getBoundingClientRect();
    root.style.setProperty("--boot-x", `${rect.left + rect.width / 2 - window.innerWidth / 2}px`);
    root.style.setProperty("--boot-y", `${rect.top + rect.height / 2 - window.innerHeight / 2}px`);
  }, [playing]);

  const onAnimationEnd = (event: AnimationEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    if (event.animationName !== "boot-splash-out") return;
    onDone();
  };

  return (
    <div
      ref={rootRef}
      className={playing ? "boot-splash is-playing" : "boot-splash"}
      onAnimationEnd={onAnimationEnd}
    >
      <div className="boot-wash" />
      <div className="boot-orb" />
      <div className="boot-lockup">
        <span className="boot-slot" />
        <div className="boot-copy">
          <p className="boot-name">{bootGlyphs(copy.productName, 4.15, titleStep)}</p>
          <p className="boot-tag">{bootGlyphs(copy.about, tagStart, tagStep)}</p>
        </div>
      </div>
    </div>
  );
}
