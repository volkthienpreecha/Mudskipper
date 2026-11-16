(() => {

// A new document starts the story at its opening; in-page links still scroll normally.
history.scrollRestoration = 'manual';
let openingInteracted = false;
const resetOpening = () => window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
resetOpening();
for (const type of ['wheel', 'touchstart', 'pointerdown', 'keydown']) {
  window.addEventListener(type, () => { openingInteracted = true; }, { once: true, passive: true });
}
window.addEventListener('mudskipper:ready', () => {
  if (!openingInteracted) { resetOpening(); }
});
window.addEventListener('pageshow', event => {
  if (event.persisted || !openingInteracted) {
    resetOpening();
  }
});

})();
