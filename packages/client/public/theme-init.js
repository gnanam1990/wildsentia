// Applies the viewer's theme before the page paints (src/themeModel.ts keeps the key in step).
// Light unless they picked dark or their device's setting; storage can be blocked (private
// windows, previews), and then the page is light.
(function () {
  var choice = 'light';
  try {
    var saved = localStorage.getItem('wildsentia-theme');
    if (saved === 'dark' || saved === 'auto') choice = saved;
  } catch (e) { /* stays light */ }
  if (choice !== 'auto') document.documentElement.dataset.theme = choice;
})();
