import { type AnimationEvent } from "react";
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
  const title = Array.from(copy.productName);
  const tag = Array.from(copy.about);
  const titleStart = 0.08;
  const titleStep = 0.05;
  const tagStart = titleStart + Math.max(title.length - 1, 0) * titleStep + 0.28;
  const tagStep = Math.min(0.04, 0.55 / Math.max(tag.length, 1));

  const onAnimationEnd = (event: AnimationEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    if (event.animationName !== "boot-splash-out") return;
    onDone();
  };

  return (
    <div
      className={playing ? "boot-splash is-playing" : "boot-splash"}
      onAnimationEnd={onAnimationEnd}
    >
      <div className="boot-copy">
        <p className="boot-name">{bootGlyphs(copy.productName, titleStart, titleStep)}</p>
        <p className="boot-tag">{bootGlyphs(copy.about, tagStart, tagStep)}</p>
      </div>
    </div>
  );
}
