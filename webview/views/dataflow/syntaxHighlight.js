function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

const KEYWORDS = /\b(def|class|if|elif|else|for|while|try|except|finally|return|with|import|from|as|match|case|pass|break|continue|raise|in|and|or|not|is)\b/g;
const NUMBERS = /\b\d+(?:\.\d+)?\b/g;

export function highlightPythonLine(line) {
  const safe = esc(line);
  return safe
    .replace(KEYWORDS, '<span class="df-kw">$1</span>')
    .replace(NUMBERS, '<span class="df-num">$&</span>');
}
