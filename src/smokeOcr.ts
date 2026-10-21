// Validacion del workflow ocr-review: PR desechable, se cierra sin merger.
export function buildQuerySmoke(table: string, id: number): string {
  return 'SELECT * FROM ' + table + ' WHERE id = ' + id;
}
