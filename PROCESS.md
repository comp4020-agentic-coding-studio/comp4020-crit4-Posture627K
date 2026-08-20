# Process overview

A reading-guide to how the work came together --- a map to your process, not an
essay about it. Markers read this file and follow its citations; they don't
trawl the repo for evidence you didn't point at, so if a moment mattered, cite
it.

This file is the shape; the course site's
[assessment page](https://comp.anu.edu.au/courses/comp4020-agentic-coding-studio/topics/assessment/#what-you-submit)
is the requirement, and its
[word counts](https://comp.anu.edu.au/courses/comp4020-agentic-coding-studio/topics/assessment/#word-counts)
cover every deliverable.

## What I built

Guitar Orbit is a browser instrument: a fixed guitar illustration sits at the centre of the screen, surrounded by six invisible concentric rings that pick a note family, while the pointer's vertical position independently picks a register above or below that family's base octave. Both feed a custom Karplus-Strong plucked-string voice in an `AudioWorkletProcessor`; the pointer's angle sweeps the voice's low-pass filter. A transparent canvas over the guitar draws only ephemeral feedback --- a fading trail, a trigger ripple, the note name --- and kicks the guitar image whenever the resolved note changes.

## The moments that mattered

1. **Ring geometry that scales with the viewport instead of hardcoding pixels, plus hysteresis so a boundary doesn't flicker.** Deriving every ring radius from the viewport's own dimensions, not a fixed pixel radius, lets the same six-ring layout work at both marking viewports (1920x1080 and 390x844). `resolveRing` also checks the *previous* ring, inside a small hysteresis margin, before reclassifying from scratch, so a pointer on a boundary holds its note instead of stuttering between two. Checked by running `geometry.test.ts` at both viewports, and by dragging slowly across a boundary in the browser to confirm the note held rather than flickered.
   [`a409ff4`](https://github.com/comp4020-agentic-coding-studio/comp4020-crit4-Posture627K/commit/a409ff4)

2. **Replacing the oscillator with a real plucked string, and a second spatial axis instead of more notes on six rings.** A `PeriodicWave` oscillator can fake a guitar's timbre but not its transient, so a richer wave shape wouldn't have fixed that; the voice moved instead to a custom Karplus-Strong `AudioWorkletProcessor` --- delay line, feedback filter, noise-burst excitation --- and the rings' fixed octaves became a note family per ring plus a register from the pointer's vertical position, so the same six rings now span three octaves. Verified by ear at both marking viewports (attack and decay read as a plucked string) and by `geometry.test.ts`'s register-hysteresis tests.
   [`e450986`](https://github.com/comp4020-agentic-coding-studio/comp4020-crit4-Posture627K/commit/e450986)

## Before you ship

`pnpm check:evidence` verifies your citations resolve to real commits, that a
reflection entry the marker reads is in `reflections/`, and that your
`CLAUDE.md` is there --- before a marker ever opens the file. It checks that
your map is traceable, not that it is good: the marker judges whether your
small, deliberately chosen set of moments shows real judgement and reflection. A
green check is not a substitute for that curation.

Images aren't checked: whether one renders is visible the moment you look. Open
this file on GitHub and look at it before you ship.
