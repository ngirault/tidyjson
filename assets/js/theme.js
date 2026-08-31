/* Applies the theme the visitor chose on the main page, before first paint.
   Kept external rather than inline so the CSP can forbid inline scripts. */
(function () {
  try {
    var t = localStorage.getItem('tidyjson.theme');
    if (t === 'light' || t === 'dark') {
      document.documentElement.setAttribute('data-theme', t);
    }
  } catch (e) { /* private mode */ }
}());
