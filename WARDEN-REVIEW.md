# WARDEN REVIEW: SYMSTEM 

**Date:** June 13, 2026
**Status:** MVP Cut (Phase 1)
**Verdict:** The core instrument is proven. The technical risk of text-to-isolated-stem generation is retired. The product stands one layer of scaffolding away from completeness.

## 1. What's working
- **The Agentic Pipeline**: The Producer (Gemini 3.5) to Instrument (Lyria) to Listening Agent (Gemini 3.5) pipeline successfully produces verified isolated stems. 
- **The Core Interaction**: Preattentive UI, the composition window, and the JSON-based trackspec are robustly implemented. The bar-quantized mixdown (`OfflineAudioContext`) and zip trackpack bundling are completely functional and execute entirely on the client, fulfilling the "local-first" pledge.
- **The Post-Enshittification Promise**: It is genuinely local-first. We do not store their loops. There are no trackers.

## 2. Technical debt and hard risks
- **Tempo / Key Matching**: Lyria sometimes ignores the prompt's BPM or key. We are currently leaning on the LLM to respect the prompt, but standardizing arbitrary audio to a rigid musical grid requires a WASM time-stretch/pitch-shift engine (like Rubber Band). This is the biggest gap between this MVP and a true DAW.
- **Bleed**: The listening agent accurately flags bleed (traces of other instruments), but we don't have a reliable fall-back to stem-separation yet to clean it up automatically. 
- **Voiceover / Safari Auto-play Quirk**: Strict handling of Apple's Web Audio buffer and autoplay state remains un-audited.

## 3. The 18+ and Legendairy Gap (Phase 2)
The client requires the application to stand "one action from live" for *both* tiers. We've scaffolded the concepts, but they are not functional:
- **Test Mode Gating**: We have not integrated the Proof 18+ ID verification flow yet.
- **Stripe Connect**: Live routing of marketplace payments (90% to creator) needs to be wired into test mode.
- **Streaming & Live Collab**: CRDT-sync (Yjs) for live editing needs true integration. 

## 4. Next steps for the cohort
- Provide the final UI polish mapping Loop Lab L1 (Piano Roll), L2 (Waveform/Control), and L3 (Agentic Edits).
- Wire up the Legendairy social features in test-mode with Clef's/Sygil's moderation constitutional agents.
- Ship the `loopster-tunnel` MVP.
