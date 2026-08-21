/* ==========================================================================
   tidyJSON

   The tree is built from DOM nodes, never from concatenated markup, and
   values go through JSON.stringify before being written with textContent.
   Deep or long sections are rendered on demand, so a multi-megabyte document
   opens without freezing the tab.

   Because unrendered branches do not exist in the DOM, search runs against
   the parsed data rather than the page, then walks the tree open to reveal
   whichever match you jump to.

   Privacy note: index.html still loads Google Analytics, and your host may
   inject the Cloudflare Insights beacon. Neither touches the JSON in the
   textarea, but both track visits, which sits awkwardly next to "no data
   tracking" in the footer.
   ========================================================================== */

(function () {
  'use strict';

  /* -- Tunables ---------------------------------------------------------- */

  var EAGER_NODES = 2500;    // nodes rendered up front before deeper ones defer
  var CHUNK = 300;           // entries rendered per batch
  var AUTO_LIMIT = 2000000;  // above this many chars, wait for an explicit click
  var AUDIT_LIMIT = 8000000;
  var DEBOUNCE = 350;
  var FIND_DEBOUNCE = 200;
  var FIND_LIMIT = 5000;     // stop collecting matches past this many
  var EXPAND_ALL_LIMIT = 25000;  // nodes; above this, Expand All refuses

  /* -- Element handles --------------------------------------------------- */

  var byId = function (id) { return document.getElementById(id); };

  var input = byId('raw-json');
  var output = byId('output');
  var notes = byId('notes');
  var errorBox = byId('error');
  var errorTitle = byId('errorTitle');
  var errorExcerpt = byId('errorExcerpt');
  var jumpBtn = byId('jumpBtn');
  var inputMeta = byId('inputMeta');
  var outputMeta = byId('outputMeta');
  var toast = byId('toast');
  var dropOverlay = byId('dropOverlay');
  var themeBtn = byId('themeBtn');

  var findInput = byId('findInput');
  var findCount = byId('findCount');
  var findPrev = byId('findPrev');
  var findNext = byId('findNext');
  var findClear = byId('findClear');

  var inspector = byId('inspector');
  var inspectorPath = byId('inspectorPath');
  var copyPathBtn = byId('copyPathBtn');
  var copyValueBtn = byId('copyValueBtn');

  var parsed = null;      // last successfully parsed value
  var hasValue = false;   // guards against a legitimate null document
  var errorPos = null;
  var fileName = null;
  var toastTimer = null;

  var rootNode = null;    // element representing the whole document
  var selectedRow = null;
  var rowCache = null;    // ordered list of visible rows, invalidated on change

  var matches = [];
  var matchIndex = -1;
  var docStats = null;   // node count and depth of the current document

  /* ======================================================================
     Theme
     ====================================================================== */

  var THEMES = ['auto', 'light', 'dark'];

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    themeBtn.textContent = 'Theme: ' + theme;
    try { localStorage.setItem('tidyjson.theme', theme); } catch (e) { /* private mode */ }
  }

  function initTheme() {
    var saved = null;
    try { saved = localStorage.getItem('tidyjson.theme'); } catch (e) { /* ignore */ }
    applyTheme(THEMES.indexOf(saved) === -1 ? 'auto' : saved);
  }

  themeBtn.addEventListener('click', function () {
    var current = document.documentElement.getAttribute('data-theme');
    applyTheme(THEMES[(THEMES.indexOf(current) + 1) % THEMES.length]);
  });

  /* ======================================================================
     Small helpers
     ====================================================================== */

  function span(cls, text) {
    var el = document.createElement('span');
    el.className = cls;
    el.textContent = text;
    return el;
  }

  function makeRow(extraClass) {
    var el = document.createElement('div');
    el.className = extraClass ? 'row ' + extraClass : 'row';
    return el;
  }

  function bytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(2) + ' MB';
  }

  function plural(n, one, many) {
    return n + ' ' + (n === 1 ? one : many);
  }

  function showToast(message) {
    toast.textContent = message;
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toast.hidden = true; }, 1800);
  }

  function copyText(text, okMessage) {
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      document.body.removeChild(ta);
      showToast(ok ? okMessage : 'Copy failed — select the text and copy manually');
    }

    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(function () {
        showToast(okMessage);
      })['catch'](fallback);
    } else {
      fallback();
    }
  }

  /* ======================================================================
     Paths
     ====================================================================== */

  var IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

  function formatPath(parts) {
    var out = '$';
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      if (typeof p === 'number') out += '[' + p + ']';
      else if (IDENTIFIER.test(p)) out += '.' + p;
      else out += '[' + JSON.stringify(p) + ']';
    }
    return out;
  }

  /* Walk up through .children wrappers, collecting the key at each level. */
  function pathOf(el) {
    var parts = [];
    var cur = el;
    while (cur && cur !== output) {
      if (cur._key !== null && cur._key !== undefined) parts.unshift(cur._key);
      var parent = cur.parentElement;
      if (parent && parent.classList.contains('children')) cur = parent.parentElement;
      else break;
    }
    return parts;
  }

  function valueAt(root, parts) {
    var cur = root;
    for (var i = 0; i < parts.length; i++) {
      if (cur === null || typeof cur !== 'object') return undefined;
      cur = cur[parts[i]];
    }
    return cur;
  }

  /* ======================================================================
     Rendering
     ====================================================================== */

  function primitive(value) {
    if (typeof value === 'string') return span('s', JSON.stringify(value));
    if (typeof value === 'number') return span('n', Object.is(value, -0) ? '-0' : String(value));
    if (typeof value === 'boolean') return span('bo', String(value));
    return span('nl', 'null');
  }

  function entriesOf(value, isArray) {
    var list = [];
    var i;
    if (isArray) {
      for (i = 0; i < value.length; i++) list.push([i, value[i]]);
    } else {
      var keys = Object.keys(value);
      for (i = 0; i < keys.length; i++) list.push([keys[i], value[keys[i]]]);
    }
    return list;
  }

  /* Each .children element carries the data needed to build the rest of it
     later: the full entry list, how many are on screen, and the elements
     already made so a path lookup can find them. */
  function attachState(children, entries, isArray) {
    children._state = {
      entries: entries,
      isArray: isArray,
      rendered: 0,
      items: [],
      keyIndex: null,
      moreRow: null
    };
  }

  function indexOfKey(state, key) {
    if (state.isArray) return typeof key === 'number' ? key : Number(key);
    if (!state.keyIndex) {
      state.keyIndex = Object.create(null);
      for (var i = 0; i < state.entries.length; i++) {
        state.keyIndex[state.entries[i][0]] = i;
      }
    }
    var found = state.keyIndex[key];
    return found === undefined ? -1 : found;
  }

  function renderBatch(children, budget) {
    var state = children._state;
    if (!state || state.rendered >= state.entries.length) return;

    if (state.moreRow) {
      state.moreRow.remove();
      state.moreRow = null;
    }

    var frag = document.createDocumentFragment();
    var from = state.rendered;
    var end = Math.min(state.entries.length, from + CHUNK);

    for (var i = from; i < end; i++) {
      var el = renderNode(
        state.entries[i][1],
        state.entries[i][0],
        !state.isArray,
        i < state.entries.length - 1,
        frag,
        budget
      );
      state.items[i] = el;
    }
    state.rendered = end;

    if (end < state.entries.length) {
      var remaining = state.entries.length - end;
      var moreRow = makeRow('row-more');
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'more';
      btn.textContent = 'Show ' + Math.min(CHUNK, remaining) + ' more of ' + plural(remaining, 'item', 'items');
      btn.addEventListener('click', function () {
        renderBatch(children, { n: 0, max: EAGER_NODES });
        invalidateRows();
      });
      moreRow.appendChild(btn);
      frag.appendChild(moreRow);
      state.moreRow = moreRow;
    }

    children.appendChild(frag);
  }

  function ensureRendered(children, index) {
    var state = children._state;
    if (!state) return;
    var guard = 0;
    while (state.rendered <= index && state.rendered < state.entries.length && guard++ < 100000) {
      renderBatch(children, { n: 0, max: EAGER_NODES });
    }
  }

  /* Returns the element that represents this value, so the parent can index
     it for later path lookups. */
  function renderNode(value, pathKey, showKey, comma, parent, budget) {
    budget.n++;

    var isObject = value !== null && typeof value === 'object';

    if (!isObject) {
      var leaf = makeRow();
      leaf._key = pathKey;
      if (showKey) {
        leaf.appendChild(span('k', JSON.stringify(String(pathKey))));
        leaf.appendChild(span('p', ': '));
      }
      leaf.appendChild(primitive(value));
      if (comma) leaf.appendChild(span('p', ','));
      parent.appendChild(leaf);
      return leaf;
    }

    var isArray = Array.isArray(value);
    var open = isArray ? '[' : '{';
    var close = isArray ? ']' : '}';
    var entries = entriesOf(value, isArray);

    if (entries.length === 0) {
      var emptyRow = makeRow();
      emptyRow._key = pathKey;
      if (showKey) {
        emptyRow.appendChild(span('k', JSON.stringify(String(pathKey))));
        emptyRow.appendChild(span('p', ': '));
      }
      emptyRow.appendChild(span('b', open + close));
      if (comma) emptyRow.appendChild(span('p', ','));
      parent.appendChild(emptyRow);
      return emptyRow;
    }

    var node = document.createElement('div');
    node.className = 'node';
    node._key = pathKey;

    var openRow = makeRow('row-open');

    var toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'toggle';
    toggle.setAttribute('aria-expanded', 'true');
    toggle.setAttribute('aria-label', 'Collapse');
    openRow.appendChild(toggle);

    if (showKey) {
      openRow.appendChild(span('k', JSON.stringify(String(pathKey))));
      openRow.appendChild(span('p', ': '));
    }
    openRow.appendChild(span('b', open));

    var fold = span('fold', '');
    fold.appendChild(span('ellipsis', '\u2026'));
    fold.appendChild(span('count', plural(entries.length, isArray ? 'item' : 'key', isArray ? 'items' : 'keys')));
    fold.appendChild(span('b', close));
    if (comma) fold.appendChild(span('p', ','));
    openRow.appendChild(fold);

    var children = document.createElement('div');
    children.className = 'children';
    attachState(children, entries, isArray);

    var closeRow = makeRow('row-close');
    closeRow.appendChild(span('b', close));
    if (comma) closeRow.appendChild(span('p', ','));

    node.appendChild(openRow);
    node.appendChild(children);
    node.appendChild(closeRow);
    parent.appendChild(node);

    if (budget.n > budget.max) {
      node.classList.add('collapsed');
      toggle.setAttribute('aria-expanded', 'false');
      toggle.setAttribute('aria-label', 'Expand');
    } else {
      renderBatch(children, budget);
    }

    return node;
  }

  function childrenOf(node) {
    return node.querySelector(':scope > .children');
  }

  function setExpanded(node, expanded) {
    if (!node.classList.contains('node')) return;
    var children = childrenOf(node);
    var toggle = node.querySelector(':scope > .row-open > .toggle');

    if (expanded && children && children._state && children._state.rendered === 0) {
      renderBatch(children, { n: 0, max: EAGER_NODES });
    }

    node.classList.toggle('collapsed', !expanded);
    if (toggle) {
      toggle.setAttribute('aria-expanded', String(expanded));
      toggle.setAttribute('aria-label', expanded ? 'Collapse' : 'Expand');
    }
    invalidateRows();
  }

  /* Open every ancestor down to a path and return the element there. */
  function revealPath(parts) {
    if (!rootNode) return null;
    var el = rootNode;

    for (var i = 0; i < parts.length; i++) {
      if (!el.classList || !el.classList.contains('node')) return null;
      setExpanded(el, true);
      var children = childrenOf(el);
      if (!children || !children._state) return null;

      var index = indexOfKey(children._state, parts[i]);
      if (index < 0) return null;

      ensureRendered(children, index);
      el = children._state.items[index];
      if (!el) return null;
    }
    return el;
  }

  /* ======================================================================
     Row selection and the inspector bar
     ====================================================================== */

  function rowFor(el) {
    if (!el) return null;
    if (el.classList.contains('node')) return el.querySelector(':scope > .row-open');
    return el;
  }

  function selectRow(row, scroll) {
    if (selectedRow) selectedRow.classList.remove('is-selected');
    selectedRow = row || null;

    if (!selectedRow) {
      inspector.hidden = true;
      return;
    }

    selectedRow.classList.add('is-selected');
    var parts = pathOf(selectedRow.classList.contains('row-open') ? selectedRow.parentElement : selectedRow);
    inspectorPath.textContent = formatPath(parts);
    inspector.hidden = false;

    if (scroll !== false) scrollIntoView(selectedRow);
  }

  function selectedPath() {
    if (!selectedRow) return [];
    return pathOf(selectedRow.classList.contains('row-open') ? selectedRow.parentElement : selectedRow);
  }

  function scrollIntoView(row) {
    var top = row.offsetTop;
    var target = top - output.clientHeight / 2 + row.offsetHeight / 2;
    output.scrollTop = Math.max(0, target);
  }

  copyPathBtn.addEventListener('click', function () {
    if (!selectedRow) return;
    copyText(inspectorPath.textContent, 'Path copied');
  });

  copyValueBtn.addEventListener('click', function () {
    if (!selectedRow || !hasValue) return;
    var value = valueAt(parsed, selectedPath());
    if (value === undefined) { showToast('Could not read that value'); return; }
    copyText(typeof value === 'string' ? value : JSON.stringify(value, null, 2), 'Value copied');
  });

  /* ======================================================================
     Keyboard navigation over the tree
     ====================================================================== */

  function invalidateRows() { rowCache = null; }

  function rowHidden(row) {
    if (row.classList.contains('row-close') &&
        row.parentElement && row.parentElement.classList.contains('collapsed')) {
      return true;
    }
    var p = row.parentElement;
    while (p && p !== output) {
      if (p.classList.contains('children') &&
          p.parentElement && p.parentElement.classList.contains('collapsed')) {
        return true;
      }
      p = p.parentElement;
    }
    return false;
  }

  function visibleRows() {
    if (rowCache) return rowCache;
    var all = output.querySelectorAll('.row');
    var list = [];
    for (var i = 0; i < all.length; i++) {
      if (!rowHidden(all[i])) list.push(all[i]);
    }
    rowCache = list;
    return list;
  }

  function moveSelection(delta) {
    var rows = visibleRows();
    if (!rows.length) return;
    var index = selectedRow ? rows.indexOf(selectedRow) : -1;
    var next = index === -1 ? (delta > 0 ? 0 : rows.length - 1) : index + delta;
    next = Math.max(0, Math.min(rows.length - 1, next));
    selectRow(rows[next]);
  }

  output.addEventListener('keydown', function (e) {
    if (e.target !== output && e.target.tagName === 'INPUT') return;

    var node = selectedRow && selectedRow.classList.contains('row-open') ? selectedRow.parentElement : null;

    if (e.key === 'ArrowDown') { e.preventDefault(); moveSelection(1); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); moveSelection(-1); return; }

    if (e.key === 'ArrowRight') {
      if (node && node.classList.contains('collapsed')) { e.preventDefault(); setExpanded(node, true); }
      return;
    }

    if (e.key === 'ArrowLeft') {
      if (node && !node.classList.contains('collapsed')) {
        e.preventDefault();
        setExpanded(node, false);
        return;
      }
      /* Already collapsed, or a leaf: step out to the parent. */
      var wrapper = selectedRow ? selectedRow.parentElement : null;
      if (wrapper && wrapper.classList.contains('row-open')) wrapper = wrapper.parentElement;
      var childrenEl = selectedRow ? selectedRow.closest('.children') : null;
      if (childrenEl && childrenEl.parentElement) {
        e.preventDefault();
        selectRow(rowFor(childrenEl.parentElement));
      }
      return;
    }

    if ((e.key === 'c' || e.key === 'C') && !e.metaKey && !e.ctrlKey && selectedRow) {
      e.preventDefault();
      copyText(inspectorPath.textContent, 'Path copied');
    }
  });

  output.addEventListener('click', function (e) {
    var toggle = e.target.closest('.toggle');
    if (toggle) {
      var node = toggle.closest('.node');
      setExpanded(node, node.classList.contains('collapsed'));
      selectRow(rowFor(node), false);
      return;
    }

    if (e.target.closest('.more')) return;

    var row = e.target.closest('.row');
    if (row && !row.classList.contains('row-more')) selectRow(row, false);
  });

  /* ======================================================================
     Search

     Runs over the parsed data, not the DOM, because unexpanded branches have
     no elements yet. Navigating to a match reveals it on the way.
     ====================================================================== */

  function collectMatches(value, needle) {
    var q = needle.toLowerCase();
    var found = [];

    (function walk(v, path) {
      if (found.length >= FIND_LIMIT) return;
      if (v === null || typeof v !== 'object') return;

      var isArray = Array.isArray(v);
      var keys = isArray ? null : Object.keys(v);
      var length = isArray ? v.length : keys.length;

      for (var i = 0; i < length && found.length < FIND_LIMIT; i++) {
        var key = isArray ? i : keys[i];
        var child = isArray ? v[i] : v[key];
        var childPath = path.concat([key]);

        var keyHit = !isArray && String(key).toLowerCase().indexOf(q) !== -1;
        var valueHit = false;
        if (child === null || typeof child !== 'object') {
          valueHit = String(child).toLowerCase().indexOf(q) !== -1;
        }
        if (keyHit || valueHit) found.push(childPath);

        walk(child, childPath);
      }
    })(value, []);

    return found;
  }

  function updateFindCount() {
    if (!findInput.value) {
      findCount.textContent = '';
      findPrev.disabled = true;
      findNext.disabled = true;
      findClear.hidden = true;
      return;
    }
    findClear.hidden = false;
    if (!matches.length) {
      findCount.textContent = 'no matches';
      findCount.classList.add('is-empty');
      findPrev.disabled = true;
      findNext.disabled = true;
      return;
    }
    findCount.classList.remove('is-empty');
    findCount.textContent = (matchIndex + 1) + ' of ' + matches.length +
      (matches.length >= FIND_LIMIT ? '+' : '');
    findPrev.disabled = false;
    findNext.disabled = false;
  }

  function goToMatch(index) {
    if (!matches.length) return;
    matchIndex = (index + matches.length) % matches.length;

    var el = revealPath(matches[matchIndex]);
    var row = rowFor(el);

    if (row) {
      var previous = output.querySelector('.is-match');
      if (previous) previous.classList.remove('is-match');
      row.classList.add('is-match');
      selectRow(row);
    }
    updateFindCount();
  }

  function runSearch() {
    var needle = findInput.value;
    matches = [];
    matchIndex = -1;

    var previous = output.querySelector('.is-match');
    if (previous) previous.classList.remove('is-match');

    if (!needle || !hasValue) { updateFindCount(); return; }

    matches = collectMatches(parsed, needle);
    if (matches.length) goToMatch(0);
    else updateFindCount();
  }

  var findTimer = null;
  findInput.addEventListener('input', function () {
    clearTimeout(findTimer);
    findTimer = setTimeout(runSearch, FIND_DEBOUNCE);
  });

  findInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (matches.length) goToMatch(matchIndex + (e.shiftKey ? -1 : 1));
      else runSearch();
    }
    if (e.key === 'Escape') {
      findInput.value = '';
      runSearch();
    }
  });

  findNext.addEventListener('click', function () { goToMatch(matchIndex + 1); });
  findPrev.addEventListener('click', function () { goToMatch(matchIndex - 1); });
  findClear.addEventListener('click', function () {
    findInput.value = '';
    runSearch();
    findInput.focus();
  });

  /* Ctrl/Cmd+F focuses our search rather than the browser's, which cannot
     see collapsed or unrendered rows anyway. */
  document.addEventListener('keydown', function (e) {
    if ((e.metaKey || e.ctrlKey) && (e.key === 'f' || e.key === 'F') && hasValue) {
      e.preventDefault();
      findInput.focus();
      findInput.select();
    }
  });

  /* ======================================================================
     Locating parse errors

     Browsers disagree about error messages: V8 sometimes reports a position
     and sometimes only an inline snippet, and Firefox and Safari use two
     more formats. Walking the document ourselves gives one consistent answer
     and lets us name the mistakes people actually make.
     ====================================================================== */

  function locateError(text) {
    var i = 0;
    var n = text.length;
    var MAX_DEPTH = 1000;

    function Problem(message, at) {
      this.message = message;
      this.pos = at === undefined ? i : at;
    }

    function fail(message, at) { throw new Problem(message, at); }

    function shown(ch) {
      if (ch === undefined || ch === '') return 'end of input';
      if (ch === '\n') return 'a line break';
      if (ch === '\t') return 'a tab';
      return '"' + ch + '"';
    }

    function skipSpace() {
      while (i < n) {
        var c = text.charAt(i);
        if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
        if (c === '/' && (text.charAt(i + 1) === '/' || text.charAt(i + 1) === '*')) {
          fail('JSON does not allow comments. Remove this to make the document valid.');
        }
        return;
      }
    }

    function parseString(what) {
      var open = i;
      i++;
      while (i < n) {
        var c = text.charAt(i);
        if (c === '"') { i++; return; }
        if (c === '\\') {
          var esc = text.charAt(i + 1);
          if (esc === '') fail('This ' + what + ' is missing its closing quote.', open);
          if ('"\\/bfnrt'.indexOf(esc) !== -1) { i += 2; continue; }
          if (esc === 'u') {
            if (!/^[0-9a-fA-F]{4}$/.test(text.substr(i + 2, 4))) {
              fail('A \\u escape needs exactly four hexadecimal digits after it.', i);
            }
            i += 6;
            continue;
          }
          fail('"\\' + esc + '" is not a valid escape. Use \\\\ for a literal backslash.', i);
        }
        if (c < ' ') {
          var name = c === '\n' ? 'A raw line break' : c === '\t' ? 'A raw tab' : 'A raw control character';
          fail(name + ' cannot appear inside a string. Escape it as ' +
            (c === '\n' ? '\\n' : c === '\t' ? '\\t' : '\\u' + ('000' + c.charCodeAt(0).toString(16)).slice(-4)) + '.', i);
        }
        i++;
      }
      fail('This ' + what + ' is missing its closing quote.', open);
    }

    function parseNumber() {
      var start = i;
      if (text.charAt(i) === '-') i++;
      if (text.charAt(i) === '0') {
        i++;
        if (text.charAt(i) >= '0' && text.charAt(i) <= '9') {
          fail('Numbers cannot have a leading zero. Write it as a string if the zeros matter.', i);
        }
      } else if (text.charAt(i) >= '1' && text.charAt(i) <= '9') {
        while (i < n && text.charAt(i) >= '0' && text.charAt(i) <= '9') i++;
      } else {
        fail('A number cannot start this way.', start);
      }
      if (text.charAt(i) === '.') {
        i++;
        if (!(text.charAt(i) >= '0' && text.charAt(i) <= '9')) fail('A decimal point needs at least one digit after it.', i);
        while (i < n && text.charAt(i) >= '0' && text.charAt(i) <= '9') i++;
      }
      if (text.charAt(i) === 'e' || text.charAt(i) === 'E') {
        i++;
        if (text.charAt(i) === '+' || text.charAt(i) === '-') i++;
        if (!(text.charAt(i) >= '0' && text.charAt(i) <= '9')) fail('An exponent needs at least one digit after it.', i);
        while (i < n && text.charAt(i) >= '0' && text.charAt(i) <= '9') i++;
      }
      if (/^[0-9a-zA-Z_.]/.test(text.charAt(i))) {
        fail('Unexpected ' + shown(text.charAt(i)) + ' in the middle of a number.', i);
      }
    }

    function parseLiteral(word) {
      if (text.substr(i, word.length) !== word) {
        var bad = /^[a-zA-Z_$]+/.exec(text.slice(i));
        if (bad) fail('"' + bad[0] + '" is not valid here. Text values must be wrapped in double quotes.', i);
        fail('Expected "' + word + '".', i);
      }
      i += word.length;
    }

    function parseValue(depth) {
      if (depth > MAX_DEPTH) fail('This document nests more than ' + MAX_DEPTH + ' levels deep.');
      skipSpace();
      if (i >= n) fail('The document ends before this value is finished.', n);

      var c = text.charAt(i);
      if (c === '{') return parseObject(depth);
      if (c === '[') return parseArray(depth);
      if (c === '"') return parseString('string');
      if (c === '-' || (c >= '0' && c <= '9')) return parseNumber();
      if (c === 't') return parseLiteral('true');
      if (c === 'f') return parseLiteral('false');
      if (c === 'n') return parseLiteral('null');
      if (c === "'") fail('JSON strings must use double quotes, not single quotes.', i);
      if (c === '}' || c === ']') fail('Unexpected ' + shown(c) + ' — there is no value here.', i);
      return parseLiteral('null');
    }

    function parseObject(depth) {
      i++;
      skipSpace();
      if (text.charAt(i) === '}') { i++; return; }

      for (;;) {
        skipSpace();
        if (i >= n) fail('The document ends before this object is closed.', n);

        var c = text.charAt(i);
        if (c === '}') fail('Trailing comma — remove the comma before this closing brace.', i);
        if (c === "'") fail('Property names must use double quotes, not single quotes.', i);
        if (c !== '"') {
          var word = /^[A-Za-z0-9_$-]+/.exec(text.slice(i));
          if (word) fail('Property name "' + word[0] + '" must be wrapped in double quotes.', i);
          fail('Expected a property name in double quotes, found ' + shown(c) + '.', i);
        }
        parseString('property name');

        skipSpace();
        if (text.charAt(i) === '=') fail('Use a colon between a property name and its value, not "=".', i);
        if (text.charAt(i) !== ':') fail('Expected a colon after this property name, found ' + shown(text.charAt(i)) + '.', i);
        i++;

        parseValue(depth + 1);

        skipSpace();
        var after = text.charAt(i);
        if (after === ',') { i++; continue; }
        if (after === '}') { i++; return; }
        if (i >= n) fail('The document ends before this object is closed.', n);
        fail('Expected a comma or a closing brace after this value, found ' + shown(after) + '.', i);
      }
    }

    function parseArray(depth) {
      i++;
      skipSpace();
      if (text.charAt(i) === ']') { i++; return; }

      for (;;) {
        skipSpace();
        if (text.charAt(i) === ']') fail('Trailing comma — remove the comma before this closing bracket.', i);
        if (text.charAt(i) === ',') fail('Empty slot — two commas in a row.', i);

        parseValue(depth + 1);

        skipSpace();
        var after = text.charAt(i);
        if (after === ',') { i++; continue; }
        if (after === ']') { i++; return; }
        if (i >= n) fail('The document ends before this array is closed.', n);
        fail('Expected a comma or a closing bracket after this value, found ' + shown(after) + '.', i);
      }
    }

    try {
      skipSpace();
      if (i >= n) return { pos: 0, message: 'There is nothing to parse yet.' };
      parseValue(0);
      skipSpace();
      if (i < n) return { pos: i, message: 'Extra content after the end of the JSON value. A document holds one value only.' };
      return null;
    } catch (problem) {
      if (problem instanceof Problem) return { pos: Math.min(problem.pos, n), message: problem.message };
      return null;
    }
  }

  function lineColumn(text, pos) {
    var line = 1;
    var lastBreak = -1;
    for (var i = 0; i < pos && i < text.length; i++) {
      if (text.charAt(i) === '\n') { line++; lastBreak = i; }
    }
    return { line: line, column: pos - lastBreak, lineStart: lastBreak + 1 };
  }

  function showError(err, text) {
    var located = locateError(text);
    var pos = located ? located.pos : null;
    var clean;

    if (located) {
      clean = located.message;
    } else {
      clean = String(err.message || err)
        .replace(/^JSON\.parse:\s*/, '')
        .replace(/,?\s*(\.\.\.)?".*"(\.\.\.)?\s*is not valid JSON/, '')
        .replace(/\s*in JSON at position \d+(\s*\(line \d+ column \d+\))?/, '')
        .replace(/\s*at line \d+ column \d+ of the JSON data/, '')
        .replace(/\s+$/, '');
      if (!clean) clean = 'This is not valid JSON.';
      clean = clean.charAt(0).toUpperCase() + clean.slice(1);
    }

    if (pos === null || isNaN(pos)) {
      errorTitle.textContent = clean;
      errorExcerpt.textContent = '';
      jumpBtn.hidden = true;
      errorPos = null;
    } else {
      pos = Math.min(pos, Math.max(0, text.length - 1));
      var at = lineColumn(text, pos);
      errorTitle.textContent = 'Line ' + at.line + ', column ' + at.column + ' — ' + clean;

      var lineEnd = text.indexOf('\n', at.lineStart);
      if (lineEnd === -1) lineEnd = text.length;
      var lineText = text.slice(at.lineStart, lineEnd);

      var windowStart = 0;
      if (lineText.length > 120) {
        windowStart = Math.max(0, at.column - 50);
        lineText = (windowStart > 0 ? '\u2026' : '') +
          lineText.slice(windowStart, windowStart + 110) +
          (windowStart + 110 < lineEnd - at.lineStart ? '\u2026' : '');
      }

      var caretAt = at.column - 1 - windowStart + (windowStart > 0 ? 1 : 0);
      errorExcerpt.textContent = lineText + '\n' + new Array(Math.max(0, caretAt) + 1).join(' ') + '^';
      jumpBtn.hidden = false;
      errorPos = pos;
    }

    errorBox.hidden = false;
  }

  function clearError() {
    errorBox.hidden = true;
    errorTitle.textContent = '';
    errorExcerpt.textContent = '';
    errorPos = null;
  }

  jumpBtn.addEventListener('click', function () {
    if (errorPos === null) return;
    input.focus();
    input.setSelectionRange(errorPos, Math.min(errorPos + 1, input.value.length));
    var ratio = errorPos / Math.max(1, input.value.length);
    input.scrollTop = Math.max(0, ratio * input.scrollHeight - input.clientHeight / 2);
  });

  /* ======================================================================
     Audit: what JSON.parse discards without telling you
     ====================================================================== */

  function auditJson(text) {
    var unsafe = [];
    var dupes = [];
    var stack = [];
    var expectKey = false;
    var i = 0;
    var n = text.length;

    while (i < n) {
      var c = text.charAt(i);

      if (c === '"') {
        var j = i + 1;
        while (j < n) {
          if (text.charAt(j) === '\\') { j += 2; continue; }
          if (text.charAt(j) === '"') break;
          j++;
        }
        if (expectKey && stack.length && stack[stack.length - 1].keys) {
          var keys = stack[stack.length - 1].keys;
          var raw = text.slice(i + 1, j);
          if (keys[raw]) {
            if (dupes.indexOf(raw) === -1) dupes.push(raw);
          } else {
            keys[raw] = true;
          }
          expectKey = false;
        }
        i = j + 1;
        continue;
      }

      if (c === '{') { stack.push({ keys: Object.create(null) }); expectKey = true; i++; continue; }
      if (c === '[') { stack.push({ keys: null }); expectKey = false; i++; continue; }
      if (c === '}' || c === ']') { stack.pop(); expectKey = false; i++; continue; }
      if (c === ',') { expectKey = !!(stack.length && stack[stack.length - 1].keys); i++; continue; }
      if (c === ':') { expectKey = false; i++; continue; }

      if (c === '-' || (c >= '0' && c <= '9')) {
        var k = i;
        while (k < n && '-+.eE0123456789'.indexOf(text.charAt(k)) !== -1) k++;
        var literal = text.slice(i, k);
        if (/^-?\d+$/.test(literal) && !Number.isSafeInteger(Number(literal))) {
          if (unsafe.indexOf(literal) === -1) unsafe.push(literal);
        }
        i = k;
        continue;
      }

      i++;
    }

    return { unsafe: unsafe, dupes: dupes };
  }

  function renderNotes(audit) {
    notes.textContent = '';
    var any = false;

    function line(text, items, max) {
      var p = document.createElement('p');
      p.appendChild(document.createTextNode(text));
      for (var i = 0; i < Math.min(items.length, max); i++) {
        if (i > 0) p.appendChild(document.createTextNode(', '));
        var code = document.createElement('code');
        code.textContent = items[i];
        p.appendChild(code);
      }
      if (items.length > max) {
        p.appendChild(document.createTextNode(' and ' + (items.length - max) + ' more'));
      }
      p.appendChild(document.createTextNode('.'));
      return p;
    }

    if (audit.unsafe.length) {
      any = true;
      notes.appendChild(line(
        plural(audit.unsafe.length, 'number is', 'numbers are') +
        ' too large for JavaScript to store exactly, so the digits shown are approximate: ',
        audit.unsafe, 3
      ));
    }

    if (audit.dupes.length) {
      any = true;
      notes.appendChild(line(
        plural(audit.dupes.length, 'key appears', 'keys appear') +
        ' more than once in the same object; only the last value survived parsing: ',
        audit.dupes, 4
      ));
    }

    notes.hidden = !any;
  }

  /* ======================================================================
     Actions
     ====================================================================== */

  function measure(value) {
    var nodes = 0;
    var deepest = 0;

    (function walk(v, depth) {
      nodes++;
      if (depth > deepest) deepest = depth;
      if (v === null || typeof v !== 'object') return;
      if (Array.isArray(v)) {
        for (var i = 0; i < v.length; i++) walk(v[i], depth + 1);
      } else {
        var keys = Object.keys(v);
        for (var j = 0; j < keys.length; j++) walk(v[keys[j]], depth + 1);
      }
    })(value, 1);

    return { nodes: nodes, depth: deepest };
  }

  function resetView(message) {
    output.textContent = '';
    var p = document.createElement('p');
    p.className = 'output__empty';
    p.textContent = message;
    output.appendChild(p);
    outputMeta.textContent = '';
    notes.hidden = true;
    rootNode = null;
    selectedRow = null;
    inspector.hidden = true;
    matches = [];
    matchIndex = -1;
    docStats = null;
    invalidateRows();
    updateFindCount();
  }

  function setFindEnabled(on) {
    findInput.disabled = !on;
    if (!on) {
      findInput.value = '';
      updateFindCount();
    }
  }

  function updateInputMeta() {
    var length = input.value.length;
    inputMeta.textContent = length ? bytes(length) + (fileName ? ' · ' + fileName : '') : '';
  }

  function formatJson(manual) {
    var text = input.value;
    updateInputMeta();

    if (!text.trim()) {
      parsed = null;
      hasValue = false;
      clearError();
      setFindEnabled(false);
      resetView('Formatted JSON will appear here.');
      return;
    }

    var value;
    try {
      value = JSON.parse(text);
    } catch (err) {
      parsed = null;
      hasValue = false;
      setFindEnabled(false);
      showError(err, text);
      if (manual) resetView('Fix the error above to see the formatted output.');
      return;
    }

    parsed = value;
    hasValue = true;
    clearError();

    output.textContent = '';
    selectedRow = null;
    inspector.hidden = true;
    matches = [];
    matchIndex = -1;
    invalidateRows();

    var frag = document.createDocumentFragment();
    rootNode = renderNode(value, null, false, false, frag, { n: 0, max: EAGER_NODES });
    output.appendChild(frag);

    setFindEnabled(true);
    if (findInput.value) runSearch(); else updateFindCount();

    var stats = measure(value);
    docStats = stats;
    outputMeta.textContent = 'valid · ' + plural(stats.nodes, 'node', 'nodes') + ' · depth ' + stats.depth;

    if (text.length <= AUDIT_LIMIT) renderNotes(auditJson(text));
    else notes.hidden = true;
  }

  function minifyJson() {
    var text = input.value;
    if (!text.trim()) return;

    var value;
    try {
      value = JSON.parse(text);
    } catch (err) {
      showError(err, text);
      return;
    }

    parsed = value;
    hasValue = true;
    clearError();

    var minified = JSON.stringify(value);
    output.textContent = '';
    rootNode = null;
    selectedRow = null;
    inspector.hidden = true;
    invalidateRows();
    setFindEnabled(false);

    var pre = document.createElement('pre');
    pre.className = 'minified';
    pre.textContent = minified;
    output.appendChild(pre);

    var saved = text.length - minified.length;
    outputMeta.textContent = 'minified · ' + bytes(minified.length) +
      (saved > 0 ? ' · ' + bytes(saved) + ' smaller' : '');
    notes.hidden = true;
  }

  function downloadJson() {
    if (!hasValue) { showToast('Nothing valid to download yet'); return; }
    var blob = new Blob([JSON.stringify(parsed, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = fileName ? fileName.replace(/\.json$/i, '') + '.formatted.json' : 'formatted.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function loadText(text, name) {
    input.value = text;
    fileName = name || null;
    formatJson(true);
    if (name) showToast('Opened ' + name);
  }

  function readFile(file) {
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () { loadText(String(reader.result), file.name); };
    reader.onerror = function () { showToast('Could not read that file'); };
    reader.readAsText(file);
  }

  /* ======================================================================
     Wiring
     ====================================================================== */

  var debounceTimer = null;

  input.addEventListener('input', function () {
    fileName = null;
    updateInputMeta();
    clearTimeout(debounceTimer);

    if (input.value.length > AUTO_LIMIT) {
      outputMeta.textContent = 'large input — press Format';
      return;
    }
    debounceTimer = setTimeout(function () { formatJson(false); }, DEBOUNCE);
  });

  byId('formatBtn').addEventListener('click', function () { formatJson(true); });
  byId('minifyBtn').addEventListener('click', minifyJson);
  byId('downloadBtn').addEventListener('click', downloadJson);

  byId('clearBtn').addEventListener('click', function () {
    input.value = '';
    fileName = null;
    parsed = null;
    hasValue = false;
    clearError();
    updateInputMeta();
    setFindEnabled(false);
    resetView('Formatted JSON will appear here.');
    input.focus();
  });

  byId('sampleBtn').addEventListener('click', function () {
    loadText(JSON.stringify({
      id: 'order_7f3a91',
      placed_at: '2025-11-04T09:21:36Z',
      customer: {
        name: 'A. Nakamura',
        email: 'a.nakamura@example.com',
        note: 'Buzzer is broken — please call.\nApartment "3B", rear entrance.',
        vip: true,
        referred_by: null
      },
      items: [
        { sku: 'KB-2891', title: 'Mechanical keyboard, 65%', qty: 1, price: 129.0 },
        { sku: 'CB-0042', title: 'USB-C cable, 2m', qty: 3, price: 11.5 }
      ],
      totals: { subtotal: 163.5, shipping: 0, tax: 13.08, grand: 176.58 },
      tracking: [],
      legacy_order_id: 9007199254740993
    }, null, 2));
  });

  byId('copyAllBtn').addEventListener('click', function () {
    if (!hasValue) { showToast('Nothing valid to copy yet'); return; }
    copyText(JSON.stringify(parsed, null, 2), 'Formatted JSON copied');
  });

  byId('expandBtn').addEventListener('click', function () {
    if (!rootNode) return;

    /* Expanding everything materialises every node at once. Past a certain
       size that locks the tab for seconds, and search is the better tool
       anyway, so refuse rather than appear to hang. */
    if (docStats && docStats.nodes > EXPAND_ALL_LIMIT) {
      showToast('Too big to expand fully (' + docStats.nodes.toLocaleString() + ' nodes) — use search instead');
      return;
    }

    var passes = 0;
    for (;;) {
      var collapsed = output.querySelectorAll('.node.collapsed');
      if (!collapsed.length || passes++ > 40) break;
      for (var i = 0; i < collapsed.length; i++) setExpanded(collapsed[i], true);
    }
    invalidateRows();
  });

  byId('collapseBtn').addEventListener('click', function () {
    var nodes = output.querySelectorAll('.node');
    for (var i = 0; i < nodes.length; i++) setExpanded(nodes[i], false);
    invalidateRows();
  });

  byId('fileInput').addEventListener('change', function (e) {
    readFile(e.target.files && e.target.files[0]);
    e.target.value = '';
  });

  /* Drag and drop. Touch devices can fire a dragenter without a matching
     dragleave, so the overlay is reset defensively rather than counted. */
  function hideOverlay() { dropOverlay.hidden = true; }

  window.addEventListener('dragenter', function (e) {
    if (!e.dataTransfer || Array.prototype.indexOf.call(e.dataTransfer.types, 'Files') === -1) return;
    dropOverlay.hidden = false;
  });

  window.addEventListener('dragover', function (e) {
    if (e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types, 'Files') !== -1) {
      e.preventDefault();
    }
  });

  window.addEventListener('dragleave', function (e) {
    if (e.relatedTarget === null || e.relatedTarget === undefined) hideOverlay();
  });

  window.addEventListener('dragend', hideOverlay);
  window.addEventListener('blur', hideOverlay);
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) hideOverlay();
  });

  window.addEventListener('drop', function (e) {
    e.preventDefault();
    hideOverlay();
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
      readFile(e.dataTransfer.files[0]);
    }
  });

  dropOverlay.addEventListener('click', hideOverlay);

  input.addEventListener('keydown', function (e) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      formatJson(true);
    }
  });

  initTheme();
  jumpBtn.hidden = true;
  setFindEnabled(false);
  updateInputMeta();
}());