# How Sound Stretches

My CS2108 Project

This is a showcase of my project for CS2108, an interactive webpage titled How Sound Stretches. The site is a scrollable technical guide designed to explain the limitations of direct sound wave modification and the implementation of phase vocoding as a solution.

https://howsoundstretches.vercel.app/

Here is some code contributed by a certain Flexibo to have more control over the toggling of harmonics:

```
document.addEventListener('keydown', (e) => {
  const num = parseInt(e.key);
  if (num >= 1 && num <= 9) {
    const buttons = document.querySelectorAll('.harmonic-btn');
    buttons[num - 1]?.click();
  }
});
```
Paste this into the debug console and press 1-9 on the keyboard as desired :)
