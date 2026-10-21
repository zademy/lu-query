// Modulo de humo para validar el workflow de OCR: este PR se cierra sin merger.
export function buildQuerySmoke(table: string, id: number): string {
  return 'SELECT * FROM ' + table + ' WHERE id = ' + id;
}
