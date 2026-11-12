import { createReadStream } from 'node:fs';

// Streaming RFC 4180 parser, including quoted newlines and escaped quotes.
export async function* csvRows(path) {
  let row = [], field = '', quoted = false, quotePending = false, headers;
  const finish = () => { row.push(field); field = ''; const result = row; row = []; return result; };
  const emit = values => {
    if (!headers) { headers = values.map((s, i) => i === 0 ? s.replace(/^\uFEFF/, '') : s); return null; }
    if (values.length !== headers.length) throw new Error('CSV column count changed');
    return Object.fromEntries(headers.map((h, i) => [h, values[i]]));
  };
  for await (const chunk of createReadStream(path, { encoding: 'utf8' })) {
    for (const c of chunk) {
      if (quotePending) {
        quotePending = false;
        if (c === '"') { field += '"'; continue; }
        quoted = false;
        if (c !== ',' && c !== '\r' && c !== '\n') throw new Error('Invalid character after CSV quote');
      } else if (quoted) {
        if (c === '"') quotePending = true; else field += c;
        continue;
      }
      if (c === '"') {
        if (field) throw new Error('Invalid CSV quote');
        quoted = true;
      } else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n') { const value = emit(finish()); if (value) yield value; }
      else if (c !== '\r') field += c;
    }
  }
  if (quoted && !quotePending) throw new Error('Unterminated CSV quote');
  if (field || row.length || quotePending) { const value = emit(finish()); if (value) yield value; }
}
