const linkInChat = 'Link im Chat';
const rawId = /^(?:[a-f\d]{32}|[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12})$/i;

function linkLabels(text, references) {
  // Pair delimiters once. Notion links and labels may contain nested or escaped parentheses.
  const ends = new Map(),
    brackets = [],
    parentheses = [];
  for (let i = 0; i < text.length; i++) {
    switch (text[i]) {
      case '\\':
        i++;
        break;
      case '[':
        brackets.push(i);
        break;
      case ']':
        if (brackets.length) ends.set(brackets.pop(), i);
        break;
      case '(':
        parentheses.push(i);
        break;
      case ')':
        if (parentheses.length) ends.set(parentheses.pop(), i);
        break;
    }
  }
  const pieces = [];
  let from = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '[' || !ends.has(i)) continue;
    const labelEnd = ends.get(i),
      after = labelEnd + 1;
    let end;
    if (text[after] === '(' && ends.has(after)) {
      end = ends.get(after);
    } else if (text[after] === '[' && ends.has(after)) {
      const key =
        text.slice(after + 1, ends.get(after)) || text.slice(i + 1, labelEnd);
      if (references.has(key.toLowerCase())) end = ends.get(after);
    } else if (
      references.size &&
      references.has(text.slice(i + 1, labelEnd).toLowerCase())
    ) {
      end = labelEnd;
    }
    if (end === undefined) continue;
    const label = text.slice(i + 1, labelEnd).trim();
    const imageStart = text[i - 1] === '!' ? i - 1 : i;
    pieces.push(
      text.slice(from, imageStart),
      label && !rawId.test(label) ? label : linkInChat,
    );
    from = end + 1;
    i = end;
  }
  pieces.push(text.slice(from));
  return pieces.join('');
}

function bareLink(url) {
  // Keep punctuation belonging to the sentence, including surrounding parentheses.
  const body = url.replace(/[.,;:!?]+$/, '');
  let end = body.length;
  let balance = 0;
  for (const char of body) {
    if (char === '(') balance++;
    if (char === ')') balance--;
  }
  while (balance < 0 && body[end - 1] === ')') {
    end--;
    balance++;
  }
  return linkInChat + url.slice(end);
}

export function spokenText(text) {
  const references = new Set();
  const content = text.replace(
    /^[ \t]{0,3}\[([^\]\r\n]+)\]:[ \t]*\S+[^\r\n]*$/gm,
    (_, key) => {
      references.add(key.toLowerCase());
      return '';
    },
  );
  return (
    linkLabels(content, references)
      .replace(/^[ \t]*(?:[-*+][ \t]+)?\[([ xX])\][ \t]+/gm, (_, mark) =>
        mark === ' ' ? 'Offen: ' : 'Erledigt: ',
      )
      .replace(/^[ \t]{0,3}(?:#{1,6}[ \t]+|(?:>[ \t]*)+)/gm, '')
      .replace(/^[ \t]*(?:[-+][ \t]+(?![\d \t])|\*[ \t]+)/gm, '')
      .replace(
        /(?<![\p{L}\p{N}])(\*{1,3}|~~)(?=\S)([^\n]*?\S)\1(?![\p{L}\p{N}])/gu,
        '$2',
      )
      .replace(
        /(?<![\p{L}\p{N}_])(_{1,3})(?=\S)([^\n]*?\S)\1(?![\p{L}\p{N}_])/gu,
        '$2',
      )
      .replace(/^[ \t]*(?:`{3,}|~{3,})[\w+#.-]*[ \t]*$/gm, '')
      .replace(/`+([^`\n]+)`+/g, '$1')
      .replace(/\\([*_[\]()])/g, '$1')
      .replace(/<(?:https?:\/\/|www\.)[^\s<>]+>/gi, linkInChat)
      .replace(/\b(?:https?:\/\/|www\.)[^\s<>"“”„«»\]]+/gi, bareLink)
      .replace(
        /(?<![\w@.-])(?:[a-z\d-]{1,63}\.)+[a-z]{2,63}(?:[/?#][^\s<>"“”„«»\]]*)/gi,
        bareLink,
      )
      .replace(
        /(?<![\w@.-])(?:[a-z\d-]{1,63}\.)+(?:de|com|org|net|io|so|site|app|dev|ai)\b/gi,
        linkInChat,
      )
      .replace(/\n(?:[ \t]*\n){2,}/g, '\n\n')
      .trim() || 'Die Antwort steht im Chat.'
  );
}
