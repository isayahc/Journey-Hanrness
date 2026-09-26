/** Render message Markdown into a container without allowing executable HTML.
 * @param {HTMLElement} container Message body to replace.
 * @param {string} content Original message text, retained unchanged in storage.
 * @returns {void}
 */
function renderMarkdown(container, content) {
  container.classList.add('markdown');
  // Keep the conversation readable if a vendor asset fails to load.
  if (!globalThis.marked || !globalThis.DOMPurify) {
    container.textContent = content;
    return;
  }
  container.replaceChildren(DOMPurify.sanitize(marked.parse(content, { gfm: true }), {
    RETURN_DOM_FRAGMENT: true,
    ALLOWED_TAGS: ['p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'strong', 'em', 'del', 'blockquote', 'ul', 'ol', 'li', 'pre', 'code',
      'a', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'input'],
    ALLOWED_ATTR: ['href', 'title', 'start', 'align', 'type', 'checked', 'disabled'],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
  }));
  for (const link of container.querySelectorAll('a')) {
    const href = link.getAttribute('href');
    if (!href || !/^(https?:\/\/|mailto:)/i.test(href)) link.removeAttribute('href');
    else { link.target = '_blank'; link.rel = 'noopener noreferrer'; }
  }
  for (const input of container.querySelectorAll('input')) {
    input.type = 'checkbox';
    input.disabled = true;
  }
  for (const table of container.querySelectorAll('table')) {
    const scroll = document.createElement('div');
    scroll.className = 'markdown-table';
    scroll.tabIndex = 0;
    scroll.setAttribute('role', 'region');
    scroll.setAttribute('aria-label', 'Scrollable table');
    table.replaceWith(scroll);
    scroll.append(table);
  }
}
