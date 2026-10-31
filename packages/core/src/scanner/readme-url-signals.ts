/** Inspect HTTP(S) path suffixes, never TLDs, query strings or fragments. */
export function findExecutableLinks(readme: string): readonly { url: string; line: number }[] {
  const results: { url: string; line: number }[] = [];
  const lines = readme.split(/\r\n|[\n\r\u2028\u2029]/);
  for (let index = 0; index < lines.length; index++) {
    for (const match of lines[index].matchAll(/https?:\/\/[^\s<>"'`]+/gi)) {
      let candidate = match[0].replace(/[.,;:!?]+$/, '');
      let balance = 0, end = candidate.length;
      for (const char of candidate) { if (char === '(') balance++; else if (char === ')') balance--; }
      while (candidate[end - 1] === ')' && balance < 0) { end--; balance++; }
      candidate = candidate.slice(0, end);
      try {
        const url = new URL(candidate);
        let pathname = url.pathname;
        try { pathname = decodeURIComponent(pathname); } catch { /* Keep malformed escapes literal. */ }
        if (/\.(?:exe|sh|bat|ps1|cmd|scr|msi)$/i.test(pathname)) {
          results.push({ url: candidate, line: index + 1 });
          break; // Preserve the existing rule's one finding per README line.
        }
      } catch { /* A malformed README URL is not an executable-file finding. */ }
    }
  }
  return results;
}
