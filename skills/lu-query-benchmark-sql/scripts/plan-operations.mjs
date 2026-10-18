export function tableOperations(plan) {
  let headers;
  const result = [];
  for (const line of (typeof plan === 'string' ? plan : '').split('\n')) {
    if (!line.trimStart().startsWith('|')) continue;
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((s) => s.trim());
    if (cells[0] === 'Id') {
      headers = cells;
      continue;
    }
    if (!headers || !/^\*?\s*\d+$/.test(cells[0])) continue;
    const get = (name) => cells[headers.indexOf(name)] ?? '';
    if (!get('Operation').startsWith('TABLE ACCESS') || !get('Name')) continue;
    const time = /^(\d+):(\d+):(\d+(?:\.\d+)?)$/.exec(get('A-Time'));
    const number = (name) => {
      const m = /^(\d+(?:\.\d+)?)([KMG])?$/i.exec(get(name));
      return m ? Number(m[1]) * ({ K: 1e3, M: 1e6, G: 1e9 }[m[2]?.toUpperCase()] || 1) : null;
    };
    result.push({
      id: Number(cells[0].replace('*', '').trim()),
      table: get('Name'),
      operation: get('Operation'),
      ms: time
        ? Math.round((Number(time[1]) * 3600 + Number(time[2]) * 60 + Number(time[3])) * 1000)
        : null,
      buffers: number('Buffers'),
      reads: number('Reads'),
      rows: number('A-Rows'),
      evidence: line,
    });
  }
  return result;
}
