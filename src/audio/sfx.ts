export type SfxId =
  | "tab"
  | "click"
  | "switchOn"
  | "switchOff"
  | "paste"
  | "loading"
  | "done"
  | "tdpUp"
  | "tdpDown";

const FILES: Record<SfxId, string> = {
  tab: "tab.wav",
  click: "click.wav",
  switchOn: "switch-on.wav",
  switchOff: "switch-off.wav",
  paste: "paste.wav",
  loading: "loading.wav",
  done: "done.wav",
  tdpUp: "tdp-up.wav",
  tdpDown: "tdp-down.wav",
};

const cache = new Map<SfxId, HTMLAudioElement>();
let loading: HTMLAudioElement | null = null;
let muted = false;

function audioFor(id: SfxId): HTMLAudioElement {
  let el = cache.get(id);
  if (!el) {
    el = new Audio(`/sounds/${FILES[id]}`);
    el.preload = "auto";
    cache.set(id, el);
  }
  return el;
}

/** Soft UI sounds; failures are ignored (autoplay / missing file). */
export function playSfx(id: SfxId) {
  if (muted || typeof Audio === "undefined") return;
  try {
    const el = audioFor(id);
    el.pause();
    el.currentTime = 0;
    void el.play().catch(() => {});
  } catch {
    /* ignore */
  }
}

export function playSwitch(on: boolean) {
  playSfx(on ? "switchOn" : "switchOff");
}

export function startLoadingSfx() {
  if (muted || typeof Audio === "undefined") return;
  try {
    if (!loading) {
      loading = new Audio(`/sounds/${FILES.loading}`);
      loading.loop = true;
      loading.preload = "auto";
    }
    loading.pause();
    loading.currentTime = 0;
    void loading.play().catch(() => {});
  } catch {
    /* ignore */
  }
}

export function stopLoadingSfx(playDone = false) {
  if (loading) {
    loading.pause();
    loading.currentTime = 0;
  }
  if (playDone) playSfx("done");
}

export function setSfxMuted(next: boolean) {
  muted = next;
  if (muted) stopLoadingSfx(false);
}

/** Warm the decode cache so the first press is not silent. */
export function preloadSfx() {
  if (typeof Audio === "undefined") return;
  (Object.keys(FILES) as SfxId[]).forEach((id) => {
    try {
      audioFor(id).load();
    } catch {
      /* ignore */
    }
  });
}
