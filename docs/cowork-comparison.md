# Structured execution comparison

This controller is designed around structured local execution rather than a screenshot-to-model loop.

| Priority | Controller path                      |
| -------- | ------------------------------------ |
| 1        | Direct API or browser SDK call       |
| 2        | DOM selector                         |
| 3        | Accessibility role or label          |
| 4        | Keyboard interaction                 |
| 5        | Desktop automation (not implemented) |
| 6        | OCR/VLM (not implemented)            |
| 7        | Raw coordinates (not implemented)    |

The Fast Path always uses Playwright directly. Optional provider reasoning belongs solely to the Slow Path and cannot be reached from Fast Path execution.
