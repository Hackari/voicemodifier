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
Paste this into the debug console and press 1-9 on the keyboard as desired 

```
document.addEventListener('keydown', (e) => {
  const slider = document.querySelector('.speed-slider');
  const map = {
    'i': -0.58,
    'o': -0.55,
    'p': -0.52,
    'z': -0.50,
    'x': -0.46,
    'c': -0.43,
    'v': -0.40,
    'b': -0.37,
    'n': -0.33,
    'm': -0.30,
  };
  if (map[e.key] !== undefined) {
    slider.value = map[e.key];
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    slider.dispatchEvent(new Event('change', { bubbles: true }));
  }
});
```
Pressing i, o, p and the entire bottom row allows one to play different notes too.
