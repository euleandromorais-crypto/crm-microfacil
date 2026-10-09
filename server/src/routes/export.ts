import { stringify } from 'csv-stringify/sync';
import ExcelJS from 'exceljs';
import type { FastifyReply } from 'fastify';
import { localDate } from '../lib/time.js';

/** Envia uma tabela como CSV (separador ;, compatível com Excel pt-BR) ou XLSX */
export async function sendTable(reply: FastifyReply, format: 'csv' | 'xlsx', name: string, header: string[], rows: unknown[][]) {
  const filename = `${name}-${localDate()}.${format}`;
  reply.header('Content-Disposition', `attachment; filename="${filename}"`);
  reply.header('Cache-Control', 'no-store');
  if (format === 'csv') {
    const csv = '﻿' + stringify([header, ...rows.map((r) => r.map((v) => (v === null || v === undefined ? '' : v)))], { delimiter: ';' });
    reply.type('text/csv; charset=utf-8');
    return reply.send(csv);
  }
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(name.slice(0, 31));
  ws.addRow(header);
  ws.getRow(1).font = { bold: true };
  for (const r of rows) ws.addRow(r.map((v) => (v === null || v === undefined ? '' : v)));
  ws.columns.forEach((c) => {
    c.width = Math.min(50, Math.max(10, ...(c.values ?? []).map((v) => String(v ?? '').length + 2)));
  });
  reply.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  return reply.send(Buffer.from(await wb.xlsx.writeBuffer()));
}
