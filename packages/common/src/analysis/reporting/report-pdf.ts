import type { LeakBundle, ScanReport } from '../../types';

export function toPdf(report: ScanReport & Record<string, any>): Buffer {
  try {
    return renderPdfWithPdfkit(report);
  } catch {
    return renderSimplePdf(report);
  }
}

function renderPdfWithPdfkit(report: ScanReport & Record<string, any>): Buffer {
  let PDFDocument: any = null;
  try { PDFDocument = require('pdfkit'); } catch { /* pdfkit not available */ }
  const doc = new PDFDocument({ margin: 50, size: 'A4' });
  const chunks: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => chunks.push(chunk));

  // Title
  doc.fontSize(22).font('Helvetica-Bold').text('Memory Leak Report', { align: 'center' });
  doc.fontSize(10).font('Helvetica').text(`Scan ID: ${report.scanId}`, { align: 'center' });
  doc.moveDown(0.5);
  doc.fontSize(9).fillColor('#666').text(`Generated: ${new Date().toISOString()}`, { align: 'center' });
  doc.moveDown(1);

  // Summary
  doc.fillColor('#000').fontSize(14).font('Helvetica-Bold').text('Summary');
  doc.moveDown(0.3);
  doc.fontSize(10).font('Helvetica');
  doc.text(`Total Candidates: ${report.summary.totalCandidates}`);
  doc.text(`Confirmed Leaks: ${report.summary.confirmedLeaks}`);
  doc.text(`Likely Leaks: ${report.summary.likelyLeaks}`);
  doc.text(`False Positives: ${report.summary.falsePositives}`);
  doc.text(`Total Bytes Lost: ${report.summary.totalBytesLost}`);
  doc.text(`Duration: ${report.summary.durationSec.toFixed(1)}s`);
  doc.text(`Tools: ${(report.summary.toolsUsed || ['n/a']).join(', ')}`);
  doc.moveDown(1);

  // Findings
  doc.fontSize(14).font('Helvetica-Bold').text('Findings');
  doc.moveDown(0.3);

  const findings = report.bundles.filter((b: LeakBundle) => b.verdict && b.verdict.verdict !== 'false_positive');
  for (let i = 0; i < Math.min(findings.length, 50); i++) {
    const b = findings[i];
    const v = b.verdict!;
    const conf = (v.confidence * 100).toFixed(0);

    if (PDFDocument && doc.y > 650) doc.addPage();

    doc.fontSize(11).font('Helvetica-Bold').fillColor('#1a1a2e')
      .text(`${i + 1}. ${b.candidate.function_name} — ${v.verdict} (${conf}%)`);
    doc.fontSize(9).font('Helvetica').fillColor('#333')
      .text(`File: ${b.candidate.file_path}:${b.candidate.line_number}`);
    doc.fontSize(9).fillColor('#555')
      .text(`Allocation: ${b.candidate.allocation_type}`);
    doc.fontSize(8).fillColor('#444')
      .text(`${v.explanation || ''}`);
    if (v.repair_suggestion) {
      doc.fontSize(8).fillColor('#0066cc')
        .text(`Fix: ${v.repair_suggestion}`);
    }
    doc.moveDown(0.5);
  }

  doc.end();
  return Buffer.concat(chunks);
}

function renderSimplePdf(report: ScanReport & Record<string, any>): Buffer {
  const findings = report.bundles.filter((b: LeakBundle) => b.verdict && b.verdict.verdict !== 'false_positive');
  const lines = [
    `Memory Leak Report: ${report.scanId}`,
    '',
    `Workspace: ${report.metadata.sourceWorkspacePath || report.metadata.workspacePath}`,
    `Status: ${report.metadata.status || 'completed'}`,
    `Confirmed leaks: ${report.summary.confirmedLeaks}`,
    `Likely leaks: ${report.summary.likelyLeaks}`,
    `False positives: ${report.summary.falsePositives}`,
    `Total bytes lost: ${report.summary.totalBytesLost}`,
    `Tools: ${(report.summary.toolsUsed || []).join(', ') || 'n/a'}`,
    `Duration: ${report.summary.durationSec.toFixed(1)}s`,
    '',
    ...findings.slice(0, 50).flatMap((b: LeakBundle, index: number) => [
      `${index + 1}. ${b.candidate.file_path}:${b.candidate.line_number} ${b.candidate.function_name}`,
      `   Verdict: ${b.verdict?.verdict || 'pending'} (${Math.round((b.verdict?.confidence || 0) * 100)}%)`,
      `   Why: ${(b.verdict?.explanation || 'No explanation').replace(/[()]/g, '').replace(/[\x00-\x1F]/g, ' ')}`,
      `   Fix: ${(b.verdict?.repair_suggestion || 'n/a').replace(/[()]/g, '').replace(/[\x00-\x1F]/g, ' ')}`,
      '',
    ]),
  ];

  const escapedLines = lines.map((line) => {
    let safe = line.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
    safe = safe.replace(/[^\x20-\x7E\n\r]/g, '?');
    return safe;
  });

  const content = [
    'BT',
    '/F1 9 Tf',
    '50 760 Td',
    '10 TL',
    ...escapedLines.map((line, index) => `${index === 0 ? '' : 'T* '}(${line}) Tj`.trim()),
    'ET',
  ].join('\n');

  const objects = [
    '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
    '2 0 obj << /Type /Pages /Count 1 /Kids [3 0 R] >> endobj',
    '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >> endobj',
    '4 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Courier >> endobj',
    `5 0 obj << /Length ${Buffer.byteLength(content, 'utf8')} >> stream\n${content}\nendstream endobj`,
  ];

  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const object of objects) {
    offsets.push(Buffer.byteLength(pdf, 'utf8'));
    pdf += `${object}\n`;
  }

  const xrefOffset = Buffer.byteLength(pdf, 'utf8');
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += '0000000000 65535 f \n';
  for (let i = 1; i < offsets.length; i++) {
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(pdf, 'utf8');
}
