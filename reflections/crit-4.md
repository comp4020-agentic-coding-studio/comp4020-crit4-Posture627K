# crit-4 reflection

**What was the breakthrough that moved the work forward?**

The breakthrough was realising the prototype was showing its own guts. The scaffold drew the guitar as a plain canvas ellipse and stroked all six ring boundaries directly onto the screen, highlighting whichever one was active in blue — a diagram of the hit-testing model, not an instrument. Opening it in the browser made that obvious in a way reading the code didn't: it looked like a target, not a guitar. Directing the agent to replace the canvas guitar with a real illustrated image and stop drawing the rings at all, then rebuild the guitar's own motion so it kicks on an actual resolved-note change instead of on the pointer merely touching the image, was the moment it stopped reading as a debug view and started reading as a toy. A second correction came from dragging into the centre and hearing the note cut out unexpectedly; the fix was treating the centre as a hold zone that keeps the last note rather than an edge that ends the gesture, and that only showed up by actually playing it, not by reading the transition logic on the page.

**What did this work change about who I want to be as a software developer?**

That loop — run it, distrust my own mental model of what the code does, and correct the agent from what I actually saw and heard in the browser rather than from what the diff claimed — is what this work changed. I want to be the kind of developer who treats the rendered, playable artefact as the only source of truth, and who redirects an agent's implementation from evidence gathered by using the thing, not from re-reading its own explanation of itself.
