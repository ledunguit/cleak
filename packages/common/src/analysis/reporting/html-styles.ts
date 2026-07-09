/** Embedded CSS for the HTML report renderer. */
export const HTML_STYLES = `
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f5f7fa; color: #1a1a2e; line-height: 1.6; }
    .container { max-width: 1200px; margin: 0 auto; padding: 24px; }
    .header { background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%); color: white; padding: 32px; border-radius: 12px; margin-bottom: 24px; }
    .header h1 { font-size: 24px; margin-bottom: 8px; }
    .header .meta { font-size: 13px; color: #a0a0c0; }
    .header .meta span { margin-right: 20px; }
    .summary-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 16px; margin-bottom: 24px; }
    .summary-card { background: white; padding: 20px; border-radius: 10px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); text-align: center; }
    .summary-card .number { font-size: 32px; font-weight: 700; }
    .summary-card .label { font-size: 12px; color: #666; text-transform: uppercase; letter-spacing: 0.5px; }
    .summary-card.danger .number { color: #dc3545; }
    .summary-card.warning .number { color: #fd7e14; }
    .summary-card.info .number { color: #0d6efd; }
    .summary-card.success .number { color: #198754; }
    table { width: 100%; border-collapse: collapse; background: white; border-radius: 10px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.08); margin-bottom: 24px; }
    th { background: #f8f9fa; padding: 12px; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; color: #666; text-align: left; border-bottom: 2px solid #dee2e6; }
    td { padding: 10px 12px; border-bottom: 1px solid #f0f0f0; font-size: 13px; vertical-align: top; }
    tr:hover { background: #f8f9ff; }
    .severity-dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; }
    code { background: #f0f0f0; padding: 2px 6px; border-radius: 4px; font-size: 12px; }
    .confidence-badge { display: inline-block; padding: 2px 8px; border-radius: 12px; color: white; font-size: 11px; font-weight: 600; margin-left: 8px; }
    .finding-detail { background: white; border-radius: 10px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); margin-bottom: 12px; overflow: hidden; }
    .finding-detail h3 { padding: 14px 20px; margin: 0; font-size: 15px; background: #fafafa; border-bottom: 1px solid #eee; }
    .finding-body { padding: 20px; }
    .finding-meta { width: 100%; margin-bottom: 16px; }
    .finding-meta td { padding: 6px 12px; border: none; font-size: 13px; }
    .finding-meta td:first-child { font-weight: 600; color: #555; width: 120px; }
    .explanation, .suggestion, .code-snippet, .root-cause, .repair-diff { margin-bottom: 16px; }
    .diff-block { font-family: 'SFMono-Regular', Menlo, Consolas, monospace; font-size: 12px; line-height: 1.4; }
    .diff-block .diff-del { display: block; color: #b02a37; background: #fbeaec; }
    .diff-block .diff-add { display: block; color: #146c43; background: #e8f5ec; }
    .finding-toggle { margin-right: 8px; font-size: 12px; }
    .severity-confirmed_leak { border-left: 4px solid #dc3545; }
    .severity-likely_leak { border-left: 4px solid #fd7e14; }
    .severity-uncertain { border-left: 4px solid #ffc107; }
    .chart-bar { display: inline-block; height: 20px; border-radius: 4px; margin-right: 2px; }
    @media print {
      body { background: white; }
      .header { background: #1a1a2e !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      .summary-card { break-inside: avoid; }
    }`;
