// Applies the viewer's theme before the page paints (src/themeModel.ts keeps the key in step).
// Storage can be blocked (private windows, previews); the page then follows the device.
(function () {
  try {
    var choice = localStorage.getItem('wildsentia-theme');
    if (choice === 'light' || choice === 'dark') document.documentElement.dataset.theme = choice;
  } catch (e) { /* follow the device */ }
})();
