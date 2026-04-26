/**
 * Themed user-facing strings. One file, one place to retheme the familiar's voice.
 * Never shown in logs — use structured log events for engineer-facing info.
 */
export const voice = {
  palaceQuiet: "The palace is quiet this turn — I speak from base knowledge alone.",
  palaceMending: "The palace is being mended — I speak without memory until it is whole again.",
  palaceBusy: "The palace is busy — a moment.",
  chatFalters: "My voice falters — the resonance is unsettled. Try again in a breath.",
  thoughtTooLarge: "This thought is too large for me to hold all at once — let me try something smaller.",
  catchingBreath: "The familiar is catching her breath.",
  notInPalace: "I don't have that in the palace. If it's something you told me before, it may not have been woven in yet.",
  weakContext: "I don't have strong palace context for this — best guess follows.",
  stuckSearching: "I'm searching the palace repeatedly — you may need to rephrase, or point me at a wing.",
} as const;

export type VoiceKey = keyof typeof voice;
