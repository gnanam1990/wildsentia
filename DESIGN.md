# Vana observer interface

The forest canvas is the experience. Controls are compact, legible instruments for observing a server-authoritative ecosystem.

## Visual direction

Use neutral smoked glass over the landscape, with the moving forest visible through blurred surfaces. The user explicitly chose glassmorphism and rejected generic icons and green live-status dots. Manrope is the single typeface, including headings and the wordmark. Use lighter heading weights, clear text navigation and plain-language state labels.

- Glass: `rgb(18 24 28 / .24)`, 10px backdrop blur, near-natural saturation and slight optical darkening for legibility. The user wants the actual forest visible through the surfaces, not solid-looking frosted cards. Modal surfaces use a 46% tint for reading.
- Text: `#f4f3ef`; secondary: `#dedfdd`; muted: `#d0d3d3`. Thin translucent rules and edge reflections establish depth.
- Radius: 12px action buttons, 18px primary panels. Buttons have translucent bevels, inset edge reflections and a pearly primary action; hover lifts by 2px and press compresses slightly. Respect reduced motion and leave map-pin positioning intact.
- No decorative live dots, green status pills, stock navigation icons or illustrated leaf mark. Active navigation uses a fine underline; Close and Focus are text controls. World markers represent actual entities or recorded locations only.
- Preserve contrast with opaque fallback surfaces when backdrop filters are unavailable or reduced transparency is preferred. Never animate backdrop blur.
- Layout: 8px spacing rhythm; clear groups; 44px interactive targets.
- All data comes from the current observation or explicitly labelled retained records. Never invent health classifications or imply that delayed recordings are live.

## Observer surface

The wordmark, factual world conditions and species picker form a compact header. A persistent text navigation bar opens exploration, events, village, journal, animal details and view settings.

The animal inspector uses Overview, Life and Record tabs. Its identity, current state, four needs and primary actions fit without scrolling in the ordinary initial view. Additional recorded facts remain accessible in tabs. Keep tab selection stable through refreshes and reset it when changing animals.

On narrow screens only one sheet is open at once. It sits above the navigation and leaves the selected subject visible. Long content scrolls inside the sheet; controls never overflow the screen. Dialogs share the same typography, colors and action hierarchy.

Use subtle sheet entry motion and respect reduced motion. Preserve visible keyboard focus, native dialog escape behavior and accessible tab navigation.
